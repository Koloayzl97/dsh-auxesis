// dsh-auxesis 回归测试：不需要网关、不需要 DSH 宿主。
//   node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 插件从 DSH_PROFILE_DIR/data/dsh-auxesis 读设置；测试用临时目录，绝不碰真实配置。
const profile = mkdtempSync(join(tmpdir(), "auxesis-test-"));
const dataDir = join(profile, "data", "dsh-auxesis");
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, "settings.json"), JSON.stringify({
  selected: ["test/model-a", "test/model-b"],
  defaultRoute: "test/model-a",
  fallbackRoute: "test/model-b",
  maxTokens: 4096,
  deadlineMs: 30000,
  temperature: 0.2,
  reasoningEffort: "",
  roots: [ROOT],
}), "utf8");
process.env.DSH_PROFILE_DIR = profile;

const JUDGMENT = JSON.stringify({
  target: "t", success_check: "s", preconditions: [], chain: [],
  crux: { item: "crux-x", why: "why" }, plan: [], assumptions: [], missing: null, confidence: 0.5,
});
const STEPS = JSON.stringify({
  read: "r", next: [{ do: "d", why: "w", expect: "e", if_fails: "f" }], stop: "stop-here", confidence: 0.6,
});

// 按 system 提示判断这次是哪种模式，返回对应的 JSON，并记录每次上游调用。
const calls = [];
const ctx = {
  tools: {
    register(def) {
      ctx.tools.map.set(def.name, def);
      return () => {};
    },
    map: new Map(),
  },
  llm: {
    stream(opts) {
      calls.push({ provider: opts.provider, model: opts.model, system: String(opts.system || "") });
      const isSteps = String(opts.system || "").includes("构造器");
      const isInvestigate = String(opts.system || "").includes("调查员");
      const body = isSteps ? STEPS : isInvestigate ? JUDGMENT : JUDGMENT;
      return (async function* () {
        yield { type: "text-delta", text: body };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    },
  },
  webServer: { register: () => () => {} },
  systemPrompt: { section: () => () => {} },
  attachments: { admitPromptContent: async (p) => p },
  inject(_deps, cb) { return cb(ctx); },
  effect(fn) { const off = fn(); return typeof off === "function" ? off : () => {}; },
  get() { return undefined; },
  on() {},
  logger: { info() {}, warn() {}, error() {} },
};

const mod = await import(pathToFileURL(join(ROOT, "lib", "index.js")).href);
mod.apply(ctx, {});

const tool = (name) => {
  const t = ctx.tools.map.get(name);
  assert.ok(t, "工具 " + name + " 未注册");
  return t;
};

test("注册了两个工具：auxesis / auxesis_investigate（auxesis_steps 已并入）", () => {
  assert.deepEqual([...ctx.tools.map.keys()].sort(), ["auxesis", "auxesis_investigate"]);
  assert.equal(ctx.tools.map.has("auxesis_steps"), false, "auxesis_steps 不应再注册");
  assert.equal(tool("auxesis").parameters.required[0], "want");
  assert.deepEqual(tool("auxesis").parameters.properties.want.enum, ["judgment", "steps"]);
});

test("非法 want 直接拒绝，不发上游请求", async () => {
  const before = calls.length;
  await assert.rejects(tool("auxesis").execute({ want: "nope", problem: "x" }), /want/);
  assert.equal(calls.length, before);
});

test("want=steps 走构造器提示，返回 next 结构", async () => {
  const out = await tool("auxesis").execute({
    want: "steps", goal: "做一件可验证的事", now: "当前事实", steps: 2,
  });
  assert.ok(Array.isArray(out.parsed.next), "parsed.next 不是数组");
  assert.equal(out.parsed.stop, "stop-here");
  assert.equal(calls.at(-1).system.includes("构造器"), true);
});

test("want=judgment 走逆向求解器提示，返回 crux 结构", async () => {
  const out = await tool("auxesis").execute({ want: "judgment", problem: "一个会返工的结论" });
  assert.equal(out.parsed.crux.item, "crux-x");
  assert.equal(calls.at(-1).system.includes("逆向求解器"), true);
});

test("合并后 want=steps 与旧别名同构：next/stop 结构不变", async () => {
  const out = await tool("auxesis").execute({ want: "steps", goal: "做一件可验证的事", now: "当前事实" });
  assert.ok(Array.isArray(out.parsed.next));
  assert.equal(out.parsed.stop, "stop-here");
});

test("judgment 缺少 problem 会被拦下", async () => {
  await assert.rejects(tool("auxesis").execute({ want: "judgment" }), /problem/);
});

test("steps 缺少现场会被拦下", async () => {
  await assert.rejects(tool("auxesis").execute({ want: "steps", goal: "有目标但没现场" }), /现场/);
});

test("judgment 会自己叫蜘蛛：fetch → 宿主取数 → 再作答", async () => {
  // 单独一套桩：第一次返回 fetch，第二次返回答案
  const map = new Map();
  let n = 0;
  const gen = (body) => (async function* () {
    yield { type: "text-delta", text: body };
    yield { type: "finish", reason: { kind: "stop" } };
  })();
  const ctx2 = {
    tools: { register(def) { map.set(def.name, def); return () => {}; } },
    llm: {
      stream() {
        const body = n++ === 0
          ? JSON.stringify({ fetch: [{ op: "read", arg: join(ROOT, "package.json"), why: "版本号" }] })
          : JUDGMENT;
        return gen(body);
      },
    },
    webServer: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    attachments: { admitPromptContent: async (p) => p },
    inject(_d, cb) { return cb(ctx2); },
    effect(fn) { const off = fn(); return typeof off === "function" ? off : () => {}; },
    get() { return undefined; },
    on() {},
    logger: { info() {}, warn() {}, error() {} },
  };
  mod.apply(ctx2, {});
  const out = await map.get("auxesis").execute({
    want: "judgment",
    problem: "这个插件的版本号是多少，主入口文件叫什么",
  });
  assert.equal(out.rounds, 2, "应该跑了两轮（取数 + 作答）");
  assert.equal(out.fetches.length, 1);
  assert.equal(out.fetches[0].op, "read");
  assert.equal(out.parsed.crux.item, "crux-x");
});
