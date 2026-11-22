// dsh-auxesis 质量门槛回归：垃圾卡/重复卡不进注入；取数超预算标 phase。
//   node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 独立临时 profile：绝不碰真实配置
const profile = mkdtempSync(join(tmpdir(), "auxesis-quality-"));
const dataDir = join(profile, "data", "dsh-auxesis");
mkdirSync(dataDir, { recursive: true });
const BASE_SETTINGS = {
  selected: ["test/model-a"],
  defaultRoute: "test/model-a",
  fallbackRoute: "",
  maxTokens: 4096,
  deadlineMs: 30000,
  temperature: 0.2,
  reasoningEffort: "",
  roots: [ROOT],
};
const writeSettings = (extra) => writeFileSync(
  join(dataDir, "settings.json"),
  JSON.stringify({ ...BASE_SETTINGS, ...(extra || {}) }),
  "utf8",
);
writeSettings();
process.env.DSH_PROFILE_DIR = profile;

const JUDGMENT = JSON.stringify({
  target: "t", success_check: "s", preconditions: [], chain: [],
  crux: { item: "crux-x", why: "why" }, plan: [], assumptions: [], missing: null, confidence: 0.5,
});

const gen = (body) => (async function* () {
  yield { type: "text-delta", text: body };
  yield { type: "finish", reason: { kind: "stop" } };
})();

function makeCtx({ map, sections, llm, routes }) {
  const ctx = {
    tools: { register(def) { map.set(def.name, def); return () => {}; } },
    llm,
    webServer: { register(opts) { if (routes && opts && opts.path) routes.set(opts.path, opts.handler); return () => () => {}; } },
    systemPrompt: { section(spec) { sections.push(spec); return () => {}; } },
    attachments: { admitPromptContent: async (p) => p },
    inject(_d, cb) { return cb(ctx); },
    effect(fn) { const off = fn(); return typeof off === "function" ? off : () => {}; },
    get() { return undefined; },
    on() {},
    logger: { info() {}, warn() {}, error() {} },
  };
  return ctx;
}

const mod = await import(pathToFileURL(join(ROOT, "lib", "index.js")).href);

test("注入段过滤占位卡与重复卡，只留最近的不同瓶颈", () => {
  writeFileSync(join(dataDir, "patterns.json"), JSON.stringify([
    { t: "t", c: "x", s: "" },                                  // 占位卡：两字段都短
    { t: "重复出现的同一个目标形态", c: "重复出现的同一个瓶颈", s: "a" },  // 重复：只该留一条
    { t: "重复出现的同一个目标形态", c: "重复出现的同一个瓶颈", s: "b" },
    { t: "另一个足够长的目标形态", c: "另一个不同的瓶颈", s: "c" },
  ]), "utf8");

  const map = new Map();
  const sections = [];
  mod.apply(makeCtx({ map, sections, llm: { stream: () => gen(JUDGMENT) } }), {});

  const text = sections[0].text();
  assert.equal(text.includes("；x"), false, "占位卡不该进注入");
  assert.equal(text.split("重复出现的同一个瓶颈").length - 1, 1, "同一瓶颈只该出现一次");
  assert.equal(text.includes("另一个不同的瓶颈"), true, "不同的瓶颈应保留");
});

test("judgment 取数预算耗尽仍要材料时标 phase=fetch-unanswered", async () => {
  const map = new Map();
  const sections = [];
  const ctx = makeCtx({
    map,
    sections,
    llm: { stream: () => gen(JSON.stringify({ fetch: [{ op: "list", arg: ROOT }] })) },
  });
  mod.apply(ctx, {});
  const out = await map.get("auxesis").execute({
    want: "judgment",
    problem: "必须看现场才能定的一件事",
    maxFetches: 0,
  });
  assert.equal(out.phase, "fetch-unanswered");
  assert.ok(Array.isArray(out.parsed.fetch), "parsed 里应保留它要的材料清单");
});

test("routePlan：逗号旧值只取第一条，未知/未勾选备选被忽略", () => {
  const plan = mod.routePlan({ current: {
    selected: ["p/a", "p/b", "p/c"],
    defaultRoute: "p/a",
    fallbackRoute: "p/b,p/c",   // 旧版遗留的逗号多条：只该迁移 p/b
  } }, "");
  assert.deepEqual(plan, ["p/a", "p/b"]);

  const unknown = mod.routePlan({ current: {
    selected: ["p/a"],
    defaultRoute: "p/a",
    fallbackRoute: "p/zzz",     // 不在勾选列表：忽略，不整串失效
  } }, "");
  assert.deepEqual(unknown, ["p/a"]);
});

test("autoDecide 开关：打开时提示段出现自动决策腿，关闭时不出现", () => {
  writeSettings({ autoDecide: true });
  const on = [];
  mod.apply(makeCtx({ map: new Map(), sections: on, llm: { stream: () => gen(JUDGMENT) } }), {});
  const onText = on[0].text();
  assert.equal(onText.includes("自动决策已开启"), true, "开启时应有第三条腿");
  assert.equal(onText.includes("仍然必须问用户"), true, "不可逆/偏好/置信不足仍问人");

  writeSettings({ autoDecide: false });
  const off = [];
  mod.apply(makeCtx({ map: new Map(), sections: off, llm: { stream: () => gen(JUDGMENT) } }), {});
  assert.equal(off[0].text().includes("自动决策已开启"), false, "关闭时不应出现自动决策腿");
});

const lastEvent = () => {
  const lines = readFileSync(join(dataDir, "events.jsonl"), "utf8").trim().split("\n");
  return JSON.parse(lines.at(-1));
};

test("事件日志：成功调用追加一行，含 tool/want/ok/kind/confidence", async () => {
  const map = new Map();
  mod.apply(makeCtx({ map, sections: [], llm: { stream: () => gen(JUDGMENT) } }), {});
  await map.get("auxesis").execute({ want: "judgment", problem: "带日志的一次调用" });

  const e = lastEvent();
  assert.equal(e.tool, "auxesis");
  assert.equal(e.want, "judgment");
  assert.equal(e.ok, true);
  assert.equal(e.kind, "ok");
  assert.equal(e.confidence, 0.5);
  assert.equal(typeof e.at, "number");
});

test("事件日志：路由失败记 ok:false 与错误类别", async () => {
  const map = new Map();
  mod.apply(makeCtx({
    map,
    sections: [],
    llm: { stream() { throw new Error("429 saturated"); } },
  }), {});

  await assert.rejects(
    map.get("auxesis").execute({ want: "judgment", problem: "会被限流的一次调用" }),
    /路由全部失败/,
  );
  const e = lastEvent();
  assert.equal(e.ok, false);
  assert.equal(e.kind, "saturated");
});

// 极简的 req/res 桩：只覆盖 /auto 用到的 writeHead/end 与 on("data"/"end")
function fakeRequest(payload) {
  const handlers = {};
  return {
    method: "POST",
    on(ev, cb) { handlers[ev] = cb; return this; },
    fire() {
      if (handlers.data) handlers.data(JSON.stringify(payload));
      if (handlers.end) handlers.end();
    },
  };
}
function fakeResponse() {
  return {
    code: 0,
    body: "",
    writeHead(code) { this.code = code; },
    end(body) { this.body = String(body || ""); },
  };
}

test("/auto 往返：开→提示段出现、关→消失、非法请求被拒", async () => {
  writeSettings({ autoDecide: false });
  const routes = new Map();
  const sections = [];
  mod.apply(makeCtx({ map: new Map(), sections, routes, llm: { stream: () => gen(JUDGMENT) } }), {});

  const handler = routes.get("/dsh-auxesis/auto");
  assert.ok(handler, "/auto 路由应已注册");
  assert.equal(sections[0].text().includes("自动决策已开启"), false, "初始应为关");

  // 开：接口写入 → 设置落盘 → 同一实例的提示段立刻反映
  const reqOn = fakeRequest({ autoDecide: true });
  const resOn = fakeResponse();
  const pOn = handler(reqOn, resOn);
  reqOn.fire();
  await pOn;
  assert.equal(resOn.code, 200);
  assert.equal(JSON.parse(resOn.body).autoDecide, true);
  assert.equal(JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8")).autoDecide, true);
  assert.equal(sections[0].text().includes("自动决策已开启"), true, "开启后提示段应出现第三条腿");

  // 关
  const reqOff = fakeRequest({ autoDecide: false });
  const resOff = fakeResponse();
  const pOff = handler(reqOff, resOff);
  reqOff.fire();
  await pOff;
  assert.equal(JSON.parse(resOff.body).autoDecide, false);
  assert.equal(sections[0].text().includes("自动决策已开启"), false, "关闭后提示段应复原");

  // 非法请求体：400，且不改动已存的值
  const reqBad = fakeRequest({ autoDecide: "yes" });
  const resBad = fakeResponse();
  const pBad = handler(reqBad, resBad);
  reqBad.fire();
  await pBad;
  assert.equal(resBad.code, 400);
  assert.equal(JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8")).autoDecide, false);
});
