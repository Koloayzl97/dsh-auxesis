// dsh-auxesis — Auxesis
//
// 三件事：
//   1. 一个模型工具 auxesis：遇到「从目标倒推」的复杂问题时同步调用，
//      走被勾选的那条路由，只把结构化结论拿回来（不把会话历史带过去）；
//   2. 一个设置页：列出本机所有已配置的 provider/model，勾选哪些允许被用来逆向；
//   3. 一段系统提示：告诉模型这些路由存在、什么时候该用它们。
//
// 路由选择在调用时校验：只能是被勾选的那几条，模型不能自己发明 provider。
//
// ⚠ 依赖纪律：本插件刻意不 import 任何 @deepseek-ai/* 运行时包。
//   profile 里的插件目录是链接（link:D:\workroom\dsh-auxesis），Node 解析裸包名时
//   会走到 D:\workroom 这一层，而那里没有 node_modules —— import 失败会让整行插件
//   停在 fiberPhase=null（dsh-self 就是这样挂掉的）。所以工具定义直接手写成
//   tools.register 认识的形状，参数校验自己写在 execute 里。
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export const name = "dsh-auxesis";
export const inject = ["tools", "llm", "webServer", "systemPrompt", "attachments"];

// 包版本：状态条与 package.json 对齐，不再手写常量
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version || "";
  } catch {
    return "";
  }
})();

const DEFAULTS = { selected: [], maxTokens: 16384, deadlineMs: 180000, temperature: 0.2, reasoningEffort: "", roots: [], fallbackRoute: "", autoDecide: false, autoSessions: {} };
const MAX_SELECTED = 32;

function dataDir() {
  const profileDir = process.env.DSH_PROFILE_DIR;
  return profileDir ? join(profileDir, "data", "dsh-auxesis") : join(homedir(), ".dsh", "dsh-auxesis");
}

function settingsPath() {
  return join(dataDir(), "settings.json");
}

function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), "utf8"));
    const selected = Array.isArray(raw.selected)
      ? raw.selected.filter((x) => typeof x === "string" && x.includes("/")).slice(0, MAX_SELECTED)
      : [];
    const num = (v, fallback, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? Math.trunc(v) : fallback);
    return {
      selected,
      autoDecide: raw.autoDecide === true,
      autoSessions: raw.autoSessions && typeof raw.autoSessions === "object"
        ? Object.fromEntries(Object.entries(raw.autoSessions).filter(([, v]) => v === true).slice(0, 50))
        : {},
      defaultRoute: typeof raw.defaultRoute === "string" ? raw.defaultRoute : "",
      fallbackRoute: typeof raw.fallbackRoute === "string" ? raw.fallbackRoute : "",
      maxTokens: num(raw.maxTokens, DEFAULTS.maxTokens, 256, 64000),
      deadlineMs: num(raw.deadlineMs, DEFAULTS.deadlineMs, 5000, 900000),
      temperature: Number.isFinite(raw.temperature) && raw.temperature >= 0 && raw.temperature <= 2
        ? raw.temperature
        : DEFAULTS.temperature,
      // 留空 = 不指定，交给路由自己的默认；填了就必须是该模型公布的强度，
      // 否则 llm seam 会在发出请求前校验失败（适配器定义的强度词汇彼此不通用）。
      reasoningEffort: typeof raw.reasoningEffort === "string" ? raw.reasoningEffort.trim().slice(0, 40) : "",
      roots: Array.isArray(raw.roots)
        ? raw.roots.filter((x) => typeof x === "string" && x.trim()).slice(0, 8).map((x) => x.trim())
        : [],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeSettings(next) {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const tmp = settingsPath() + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  renameSync(tmp, settingsPath());
}

// ── 事件日志：每次调用结束追加一行 JSONL，供事后统计触发率、失败类型与开关效果。
//    写失败静默——观测不能拖垮调用本身。超过 2MB 滚一份 events.1.jsonl（约 5000 行）。
const EVENTS_MAX_BYTES = 2 * 1024 * 1024;

function eventsPath() {
  return join(dataDir(), "events.jsonl");
}

function logEvent(entry) {
  try {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    const p = eventsPath();
    try {
      if (statSync(p).size > EVENTS_MAX_BYTES) renameSync(p, join(dir, "events.1.jsonl"));
    } catch {
      // 文件还不存在
    }
    writeFileSync(p, JSON.stringify(entry) + "\n", { flag: "a", encoding: "utf8" });
  } catch {
    // 观测失败不影响调用
  }
}

// ── 经验沉淀：每次成功逆向抽一张卡（目标形态 → 瓶颈类型 → 第一步），
//    以最近若干张注入系统提示，让下一次的初稿更准、需要外援的次数更少。
function patternsPath() {
  return join(dataDir(), "patterns.json");
}

function readPatterns() {
  try {
    const list = JSON.parse(readFileSync(patternsPath(), "utf8"));
    return Array.isArray(list)
      ? list.filter((x) => x && typeof x.c === "string" && typeof x.t === "string")
      : [];
  } catch {
    return [];
  }
}

function writePatterns(list) {
  mkdirSync(dataDir(), { recursive: true });
  const tmp = patternsPath() + ".tmp";
  writeFileSync(tmp, JSON.stringify(list.slice(-40), null, 2), "utf8");
  renameSync(tmp, patternsPath());
}

function distill(value) {
  const p = value && value.parsed;
  if (!p) return undefined;
  const cut = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const target = cut(p.target, 46);
  const crux = cut(p.crux && p.crux.item, 26);
  const step = cut(Array.isArray(p.plan) && p.plan[0] && p.plan[0].step, 40);
  // 质量门槛：占位符（t/c 太短）与同义复述（t === c）不是模式，既不入库也不注入
  if (target.length < 8 || crux.length < 6 || target === crux) return undefined;
  return { t: target, c: crux, s: step };
}

function playbooksPath() {
  return join(dataDir(), "playbooks.json");
}

function readPlaybooks() {
  try {
    const list = JSON.parse(readFileSync(playbooksPath(), "utf8"));
    return Array.isArray(list) ? list.filter((x) => x && typeof x.g === "string") : [];
  } catch {
    return [];
  }
}

function writePlaybooks(list) {
  mkdirSync(dataDir(), { recursive: true });
  const tmp = playbooksPath() + ".tmp";
  writeFileSync(tmp, JSON.stringify(list.slice(-40), null, 2), "utf8");
  renameSync(tmp, playbooksPath());
}

function distillPlaybook(args, parsed) {
  const g = String(args && args.goal || "").replace(/\s+/g, " ").trim().slice(0, 46);
  const first = parsed && Array.isArray(parsed.next) && parsed.next[0] && parsed.next[0].do;
  if (!g || typeof first !== "string" || !first.trim()) return undefined;
  // 多行构造只记第一条非空行：整段压平会把命令截成半截，反而不可执行
  const head = String(first).split(/\r?\n/).map((x) => x.trim()).find(Boolean) || "";
  return {
    g,
    a: String(args && args.artifact || "procedure"),
    s: head.replace(/\s+/g, " ").trim().slice(0, 120),
  };
}

// 注入前清洗：丢掉占位卡，按瓶颈/目标去重（同一件事只留最近一次），再取最近 N 条。
// 写入端有门槛挡新的，这里挡历史遗留——旧数据里的重复不该每轮都占提示词。
function summarizePatterns(list) {
  const seen = new Set();
  const out = [];
  for (const x of [...(list || [])].reverse()) {
    const c = x && typeof x.c === "string" ? x.c.trim() : "";
    const t = x && typeof x.t === "string" ? x.t.trim() : "";
    if (c.length < 6 || t.length < 8 || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    if (out.length >= 5) break;
  }
  return out.reverse();
}

function summarizePlaybooks(list) {
  const seen = new Set();
  const out = [];
  for (const x of [...(list || [])].reverse()) {
    const g = x && typeof x.g === "string" ? x.g.trim() : "";
    const s = x && typeof x.s === "string" ? x.s.trim() : "";
    if (!g || !s || seen.has(g)) continue;
    seen.add(g);
    out.push(g + " → " + s);
    if (out.length >= 3) break;
  }
  return out.reverse();
}

// ── 蜘蛛的手：只读、限定在 roots 内、按名字/扩展名拒凭据，不跟随符号链接
const BLOCKED_NAMES = new Set([".credentials.yaml", ".credentials.yml", ".env", ".npmrc", ".netrc"]);
const BLOCKED_EXT = new Set([".pem", ".key", ".pfx", ".p12"]);
const IMAGE_EXT = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

function safePath(p, roots) {
  const full = resolve(String(p || ""));
  const inside = (roots || []).some((root) => {
    const r = resolve(String(root));
    const rel = relative(r, full);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!inside) return { error: "路径不在允许的 roots 内" };
  const base = full.split(/[\\/]/).pop() || "";
  if (BLOCKED_NAMES.has(base.toLowerCase())) return { error: "按名字拒绝读取凭据类文件" };
  const ext = (base.match(/\.[^.]+$/) || [""])[0].toLowerCase();
  if (BLOCKED_EXT.has(ext)) return { error: "按扩展名拒绝读取密钥文件" };
  try {
    const st = lstatSync(full);
    if (st.isSymbolicLink()) return { error: "拒绝跟随符号链接/联接" };
  } catch {
    return { error: "路径不存在" };
  }
  return { full, base, ext };
}

// 开局就把可搜目录摊开：否则模型只能盲扫 roots，命中配额被无关文件吃光
function searchScopeText(roots) {
  const lines = [];
  for (const r of (roots || []).slice(0, 3)) {
    let names = [];
    try {
      names = readdirSync(r).filter((n) => !n.startsWith(".") && n !== "node_modules");
    } catch {
      names = [];
    }
    const shown = names.slice(0, 24);
    lines.push("· " + r + (shown.length ? "（含：" + shown.join("、") + (names.length > shown.length ? " …" : "") + "）" : "（空或不可读）"));
  }
  return lines.join("\n");
}

function runFetch(op, roots) {
  const kind = String((op && op.op) || "").toLowerCase();
  const arg = String((op && op.arg) || "").trim();
  // grep 允许只给 pattern + path（不写 arg）；其它操作必须有 arg
  if (kind !== "grep" && !arg) return "（缺少参数）";
  if (kind === "grep" && !arg && !(op && op.pattern)) return "（grep 需要 pattern）";
  if (kind === "list") {
    const s = safePath(arg, roots);
    if (s.error) return s.error + "：" + arg;
    try {
      const names = readdirSync(s.full).slice(0, 200);
      return "目录 " + arg + "（" + names.length + " 项）：\n" + names.join("\n");
    } catch (e) {
      return "列目录失败：" + String((e && e.message) || e);
    }
  }
  if (kind === "read") {
    const s = safePath(arg, roots);
    if (s.error) return s.error + "：" + arg;
    try {
      if (statSync(s.full).size > 512 * 1024) return "文件过大（>512KB）：改用 grep 或 tail";
      const text = readFileSync(s.full, "utf8");
      const rawOffset = Number(op.offset);
      const hasOffset = Number.isFinite(rawOffset) && rawOffset > 0;
      const limit = Math.min(20000, Math.max(500, Number(op.limit) || 8000));
      // 大文件盲读会一次吃掉整个取数预算：未指定 offset 时先给索引，逼出「先 grep 再精读」
      if (!hasOffset && text.length > 20000) {
        const lines = text.split(/\r?\n/).length;
        return "[大文件：全文 " + text.length + " 字符 / " + lines + " 行。未指定 offset 时只返回头 2000 与尾 1000 字符。\n"
          + "先用 grep（带 pattern 与 path）定位，再带 offset/limit 精读。]\n"
          + "--- 头部 ---\n" + text.slice(0, 2000)
          + "\n--- 尾部 ---\n" + text.slice(-1000);
      }
      const offset = hasOffset ? Math.trunc(rawOffset) : 0;
      const end = offset + limit;
      const slice = text.slice(offset, end);
      // 截断提示放在**最前面**：模型先看到边界，才不会把半截当全文
      const header = end < text.length
        ? "[截断：全文 " + text.length + " 字符，本次只返回 " + offset + "–" + end + "；要后面就带 offset=" + end + "]\n"
        : (offset > 0 ? "[从第 " + offset + " 字符开始，全文 " + text.length + " 字符]\n" : "");
      return header + slice;
    } catch (e) {
      return "读取失败：" + String((e && e.message) || e);
    }
  }
  if (kind === "tail") {
    const s = safePath(arg, roots);
    if (s.error) return s.error + "：" + arg;
    try {
      const lines = readFileSync(s.full, "utf8").split(/\r?\n/);
      const n = Math.min(200, Math.max(10, Number(op.n) || 80));
      return "最后 " + n + " 行：\n" + lines.slice(-n).join("\n");
    } catch (e) {
      return "读取失败：" + String((e && e.message) || e);
    }
  }
  if (kind === "grep") {
    if (!op || !op.pattern) {
      const bad = String(arg);
      if (bad.includes("*") || bad.includes("?")) {
        return "grep 不支持通配符：" + bad
          + "（正确写法：{\"op\":\"grep\",\"pattern\":\"关键词\",\"path\":\"要搜的目录\"}）";
      }
    }
    // grep 的自然写法有两种：{pattern, path} 或只给一个词当关键词。
    // 只给一个词时它是 pattern，不是路径——默认在 roots[0] 里搜。
    const looksLikePath = /[\\/]/.test(arg) || /^[A-Za-z]:/.test(arg);
    const pattern = String((op && op.pattern) || arg).trim();
    let re;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      re = undefined;
    }
    const target = String((op && op.path) || (looksLikePath ? arg : (roots[0] || ".")));
    const s = safePath(target, roots);
    if (s.error) {
      return s.error + "：" + target
        + "（grep 的写法：{\"op\":\"grep\",\"pattern\":\"关键词\",\"path\":\"要搜的目录或文件\"}；只给关键词时会在 roots 第一个目录里搜）";
    }
    const hits = [];
    const walk = (p) => {
      if (hits.length >= 60) return;
      let st;
      try {
        st = statSync(p);
      } catch {
        return;
      }
      if (st.isDirectory()) {
        let names = [];
        try {
          names = readdirSync(p);
        } catch {
          return;
        }
        for (const name of names.slice(0, 500)) {
          if (hits.length >= 60) return;
          // 跳过依赖与隐藏目录：.tmp/.cache 这类会把命中配额吃光
          if (name === "node_modules" || name.startsWith(".")) continue;
          walk(join(p, name));
        }
        return;
      }
      if (st.size > 2 * 1024 * 1024) return;
      let text;
      try {
        text = readFileSync(p, "utf8");
      } catch {
        return;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < 60; i++) {
        if (re ? re.test(lines[i]) : lines[i].includes(pattern)) {
          hits.push(p + ":" + (i + 1) + ": " + lines[i].slice(0, 200));
        }
      }
    };
    walk(s.full);
    if (!hits.length) return "没有匹配：" + pattern + "（在 " + target + " 下，已跳过隐藏目录与 node_modules）";
    return "在 " + target + " 下搜「" + pattern + "」，命中 " + hits.length + " 条"
      + (hits.length >= 60 ? "（已到 60 条上限，用 path 收窄范围）" : "") + "：\n" + hits.join("\n");
  }
  return "不认识的取数操作：" + kind + "（只支持 read / tail / list / grep）";
}

async function loadImageParts(ctx, paths, roots) {
  if (!ctx.attachments || typeof ctx.attachments.admitPromptContent !== "function") {
    return { error: "本部署没有附件服务，无法发送图片" };
  }
  const parts = [];
  for (const p of paths.slice(0, 4)) {
    const s = safePath(p, roots);
    if (s.error) return { error: s.error + "：" + p };
    const mediaType = IMAGE_EXT[s.ext];
    if (!mediaType) return { error: "不支持的图片格式：" + p };
    let bytes;
    try {
      bytes = readFileSync(s.full);
    } catch (e) {
      return { error: "读图失败：" + String((e && e.message) || e) };
    }
    if (bytes.length > 5 * 1024 * 1024) return { error: "图片过大（>5MB）：" + p };
    parts.push({ type: "image", data: bytes.toString("base64"), mediaType });
  }
  try {
    const admitted = await ctx.attachments.admitPromptContent(parts);
    return { blocks: admitted };
  } catch (e) {
    return { error: "图片准入失败：" + String((e && e.message) || e) };
  }
}

// ── 错误分流：不同错误的重试与切换策略不一样 ──────────────
const KIND = {
  filter: { label: "内容过滤", cooldown: 600000, retry: 0 },
  saturated: { label: "通道饱和", cooldown: 120000, retry: 0 },
  unavailable: { label: "服务不可用", cooldown: 60000, retry: 1 },
  network: { label: "网络抖动", cooldown: 30000, retry: 1 },
  timeout: { label: "超时", cooldown: 30000, retry: 0 },
  config: { label: "配置错误", cooldown: 0, retry: 0, fatal: true },
  other: { label: "请求失败", cooldown: 20000, retry: 0 },
};

function classifyError(msg) {
  const s = String(msg || "");
  if (/content[_ ]?filter/i.test(s)) return "filter";
  if (/\b429\b|saturat/i.test(s)) return "saturated";
  if (/\b50[234]\b|temporarily unavailable|overload/i.test(s)) return "unavailable";
  if (/timeout|aborted|超时/i.test(s)) return "timeout";
  if (/\b40[0134]\b|model_not_found|unauthoriz|forbidden/i.test(s)) return "config";
  if (/ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|network/i.test(s)) return "network";
  return "other";
}

// 跨调用的路由健康记忆：失败过的路由冷却一段时间，下次先打健康的
const healthPath = () => join(dataDir(), "health.json");
let health = (() => {
  try {
    const raw = JSON.parse(readFileSync(healthPath(), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
})();

function saveHealth() {
  try {
    writeFileSync(healthPath(), JSON.stringify(health), "utf8");
  } catch {
    // 健康记忆写不进去不影响本次调用
  }
}

function markCooling(route, kind) {
  const spec = KIND[kind] || KIND.other;
  if (!spec.cooldown) return;
  health[route] = { until: Date.now() + spec.cooldown, kind };
  saveHealth();
}

function markHealthy(route) {
  if (health[route]) {
    delete health[route];
    saveHealth();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 路由计划：显式指定的只走它；否则 主路由 → 备选路由（都在勾选列表内）
export function routePlan(settings, wanted) {
  const sel = settings.current.selected || [];
  if (wanted) return [wanted];
  const primary = settings.current.defaultRoute && sel.includes(settings.current.defaultRoute)
    ? settings.current.defaultRoute
    : sel[0];
  const list = primary ? [primary] : [];
  // 单条备选：设置页与 /select 都只认一条。旧配置若存过逗号分隔的多条，
  // 只迁移第一条——否则整串匹配不上，会静默退回主路由。
  const rawFb = String(settings.current.fallbackRoute || "").trim();
  const fb = rawFb.includes(",") ? rawFb.split(",")[0].trim() : rawFb;
  if (fb && fb !== primary && sel.includes(fb)) list.push(fb);
  return list;
}

// 按错误类型处置：过滤/饱和立即换组，不可用只快速重试一次，配置错直接中止
async function runWithRoutes(ctx, routes, opts) {
  const now = Date.now();
  const fresh = routes.filter((r) => !health[r] || health[r].until <= now);
  const cooling = routes.filter((r) => health[r] && health[r].until > now);
  const ordered = [...fresh, ...cooling];
  const failures = [];

  for (const r of ordered) {
    let burnt = 0;
    for (;;) {
      try {
        const run = await runStream(ctx, { ...opts, parts: splitRoute(r) });
        markHealthy(r);
        return { run, route: r, fellBackFrom: r === routes[0] ? null : routes[0], failures };
      } catch (e) {
        const msg = String((e && e.message) || e);
        const kind = e.kind || classifyError(msg);
        const spec = KIND[kind] || KIND.other;
        if (spec.fatal) throw e;
        if (burnt < spec.retry) {
          burnt += 1;
          await sleep(700);
          continue;
        }
        markCooling(r, kind);
        failures.push({ route: r, kind, label: spec.label });
        break;
      }
    }
  }

  const detail = failures.map((f) => "  · " + f.route + "：" + f.label).join("\n");
  const hasFilter = failures.some((f) => f.kind === "filter");
  const hasCapacity = failures.some((f) => f.kind === "saturated" || f.kind === "unavailable");
  const advice = [
    hasFilter ? "内容过滤是不可重试的拒答——换 claude-sonnet-5 / claude-opus-4-8，或把问题降到「先做什么、怎么排优先级」的层面。" : "",
    hasCapacity ? "上游饱和/不可用——等 60–120 秒再试；同一句话立刻重问大概率还是失败。" : "",
  ].filter(Boolean).join("\n");
  // 失败也记：同类失败归组是后面「连续两次失败提醒」的数据源
  logEvent({
    at: Date.now(),
    tool: (opts.log && opts.log.tool) || "auxesis",
    want: (opts.log && opts.log.want) || null,
    autoDecide: Boolean(opts.settings && opts.settings.current && opts.settings.current.autoDecide),
    ok: false,
    kind: failures.length ? failures[0].kind : "other",
    route: failures.length ? failures[0].route : null,
    failedRoutes: failures.map((f) => f.route + ":" + f.kind).slice(0, 5),
    elapsedMs: null,
  });
  throw new Error("Auxesis 的路由全部失败：\n" + detail + (advice ? "\n" + advice : ""));
}

function splitRoute(route) {
  const i = String(route).indexOf("/");
  if (i <= 0 || i === String(route).length - 1) return undefined;
  return { provider: route.slice(0, i), model: route.slice(i + 1) };
}

// 两个工具共用的一段：选路由 + 流式取文本。分开写只会让它们各自漂移。
function pickRoute(selected, wanted, defaultRoute) {
  if (!selected.length) {
    throw new Error("没有勾选任何 Auxesis 路由。请在 插件 → Auxesis 里勾选至少一条模型，再调用本工具。");
  }
  const fallback = selected.includes(defaultRoute) ? defaultRoute : selected[0];
  const route = wanted || fallback;
  if (!selected.includes(route)) {
    throw new Error("route 不在勾选列表内：" + route + "。可用：" + selected.join(" / "));
  }
  const parts = splitRoute(route);
  if (!parts) throw new Error("route 格式应为 provider/model：" + route);
  return { route, parts, explicit: Boolean(wanted) };
}

async function runStream(ctx, opts) {
  const { parts, system, user, messages: given, settings, stats, label } = opts;
  const started = Date.now();
  stats.calls += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.current.deadlineMs);
  let text = "";
  let stop;
  try {
    const messages = given || [{
      role: "user",
      id: randomUUID(),
      content: [{ type: "text", text: user }],
      source: { kind: "plugin", plugin: "dsh-auxesis" },
    }];
    for await (const chunk of ctx.llm.stream({
      provider: parts.provider,
      model: parts.model,
      system,
      messages,
      maxTokens: settings.current.maxTokens,
      temperature: settings.current.temperature,
      ...(settings.current.reasoningEffort ? { reasoningEffort: settings.current.reasoningEffort } : {}),
      signal: controller.signal,
    })) {
      if (!chunk) continue;
      if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
      if (chunk.type === "finish") {
        stop = chunk.reason;
        if (chunk.reason && chunk.reason.kind === "error") {
          const detail = chunk.reason.failure?.message || JSON.stringify(chunk.reason);
          const err = new Error("上游返回错误：" + detail);
          err.kind = classifyError(detail);
          throw err;
        }
      }
    }
    clearTimeout(timer);
    return { text, stop, elapsedMs: Date.now() - started };
  } catch (e) {
    clearTimeout(timer);
    const msg = String((e && e.message) || e);
    stats.fail += 1;
    const err = new Error(msg);
    err.kind = e.kind || classifyError(msg);
    if (err.kind === "filter") {
      err.message = "上游内容过滤拦截（content_filter）：提供方在生成时拒答，重试无效——要换模型或换问法。";
    } else if (controller.signal.aborted) {
      err.kind = "timeout";
      err.message = label + "超时（" + settings.current.deadlineMs + "ms）。可以调大设置里的超时，或换一条更快的路由。";
    }
    throw err;
  }
}

// 构造类任务的回执：目标 → 步骤序列 → 停手条件
const STEPS_PROMPT = [
  "你是「构造器」：对方有目标和现场，但拼不出那条路。你给出**可直接执行或直接使用的步骤序列**，不是泛泛建议。",
  "",
  "硬要求：",
  "1. 只给能立刻做的事：命令、配置片段、操作步骤。不要写“先分析一下”“可以考虑”这类空话。",
  "2. 每一步都要带 expect——正常应该看到什么。没有可观察的成功判据，就不要把那一步写进去。",
  "3. 每一步都要带 if_fails——失败时换哪条路，一句话。",
  "4. 顺序必须能跑：第 N 步依赖的东西，必须在第 N 步之前已经产生。",
  "5. 尊重对方给的约束（不能重启、不能联网、特定版本、特定权限）；做不到就直说做不到，并给最近的可行替代。",
  "6. 只给下一步的窗口：最多 5 步，不要一次写完整场战役。",
  "7. do 如果是文件内容或连续命令，用换行原样分行写（JSON 字符串里就是 \\n），不要用斜线或分号串成一行叙述。",
  "8. do 只放可执行、可复制的内容：写文件时只给文件体，别把「随后手动跑一下」混进文件体；确需额外的验证命令时，用空行隔开，并以「验证：」开头，让执行者能分清哪些是文件、哪些是要跑的。",
  "9. 只依据给出的「当前事实 / 卡点 / 已试过 / 约束」推理。没给的信息不要假设；缺关键事实时，把「先确认它」写成第一步，而不是绕过它。",
  "",
  "长度纪律：read 一句话；每步 do ≤ 400 字（多行时按行写）、why ≤ 30 字、expect ≤ 40 字、if_fails ≤ 40 字；stop 一句话。",
  "",
  "只输出 JSON，字段固定：",
  '{"read":string,"next":[{"do":string,"why":string,"expect":string,"if_fails":string}],"stop":string,"confidence":number}',
  "不要输出 JSON 以外的任何字符，不要用 Markdown 代码块包裹。",
].join("\n");

const INVESTIGATE_PROMPT = [
  "你是「调查员」：对方给你目标与现场，你可以要求宿主去取材料（只读、限定目录），取数次数有限。",
  "",
  "每轮只输出两种 JSON 之一：",
  '{"fetch":[{"op":"list","arg":"D:\\\\workroom"}]}',
  '{"fetch":[{"op":"grep","pattern":"roots","path":"D:\\\\workroom\\\\dsh-auxesis","why":"找定义"}]}',
  '{"fetch":[{"op":"read","arg":"D:\\\\workroom\\\\dsh-auxesis\\\\lib\\\\index.js"}]}', 
  '{"answer":{"target":string,"success_check":string,"preconditions":[{"item":string,"status":"have|missing|unknown","check":string}],"chain":[{"from":string,"to":string,"why":string,"certain":boolean}],"crux":{"item":string,"why":string},"plan":[{"step":string,"done_when":string}],"assumptions":[{"assumption":string,"falsify":string}],"missing":string|null,"confidence":number}}',
  "",
  "取数纪律：",
  "1. 先取最可能含答案的一两处，不要一次扫整棵树。",
  "2. 一次最多 4 个操作；read 用于短文件，tail 用于日志，grep 用 op.pattern + op.path 在目录里找关键词，list 看目录。",
  "3. 已经看到答案就马上 answer；材料不够再 fetch，但预算用完就必须用现有材料作答。",
  "4. 只输出 JSON，不要解释，不要 Markdown 代码块。",
].join("\n");

function investigateUserText(args, budget) {
  const lines = [
    "目标：" + String(args.goal || "").trim(),
    "现场：" + String(args.state || "").trim(),
    "取数预算：" + budget + " 次（超过就必须用现有材料作答）",
  ];
  if (Array.isArray(args.images) && args.images.length) {
    lines.push("随题附了图片：" + args.images.join("、"));
  }
  lines.push("", "按约定只输出 JSON。");
  return lines.join("\n");
}

function stepsUserText(args) {
  const want = Number.isFinite(args.steps) ? Math.min(5, Math.max(1, Math.trunc(args.steps))) : 3;
  const lines = [
    "目标：" + String(args.goal || "").trim(),
    "产物类型：" + String(args.artifact || "procedure"),
  ];
  const section = (label, value) => {
    if (typeof value === "string" && value.trim()) lines.push("", label, value.trim());
  };
  section("当前事实：", args.now);
  section("卡在哪 / 原始报错：", args.blocked);
  section("已试过（失败）：", args.tried);
  section("硬约束：", args.constraints);
  const structured = [args.now, args.blocked, args.tried, args.constraints]
    .some((x) => typeof x === "string" && x.trim());
  if (!structured && typeof args.state === "string" && args.state.trim()) {
    const st = args.state.trim();
    lines.push("", "现场：", st.length > 1500 ? st.slice(0, 1500) + "…（已截断，历史流水请删掉）" : st);
  }
  const last = args.last;
  if (last && typeof last === "object") {
    lines.push("", "上一次尝试：", String(last.attempt || "").trim());
    lines.push("结果：" + String(last.result || "").trim());
    if (last.ok !== undefined) lines.push("是否成功：" + (last.ok ? "是" : "否"));
  }
  lines.push("", "步数上限：" + want + " 步。最多写 " + want + " 步，够用就停，不要凑数；剩下的等下一步再看现场。");
  lines.push("", "按约定只输出 JSON。");
  return lines.join("\n");
}

const SYSTEM_PROMPT = [
  "你是「逆向求解器」，不是聊天助手。对方给的是一个想要的结果或一个难点，你从目标反推，不正向罗列可能性。",
  "",
  "按这个顺序做完，不要跳步：",
  "1. 把目标改写成一条可验证的成功条件（有可观察的判定标准）。",
  "2. 列必要前提：每一项都要能被检查真假；区分「已经具备」与「尚未具备」。",
  "3. 建倒推链：目标 ← 直接前提 ← 更前置的条件……一直推到已知或可控的事实；任何一跳不确定就标 certain=false。",
  "4. 找瓶颈：既必要、又当前缺失、且卡住最多下游的那一条前提。",
  "5. 给最短正向路径：从当前状态出发，按顺序只做能创造瓶颈前提的动作，每步带完成判据。",
  "6. 列隐含假设，每条配一个可执行的否证方式。",
  "7. 信息不足时：若缺的那个事实能在仓库/日志里直接查到，先要材料——只输出 {\"fetch\":[{\"op\":\"read|tail|list|grep\",\"arg\":\"路径或模式\",\"why\":\"要找什么\"}]}（次数有限），拿到材料再按下面的字段作答。",
  "8. 查不到或不能查时，只指出「最关键的一个缺失事实」，不要猜。",
  "9. 最后给 decision：一句话说「所以该怎么选」，是执行者能直接照做的那句；没把握就写空字符串。再给 extend：plan 之外 2–3 条值得顺带做的延伸，没有就给空数组。",
  "要材料时照抄这三种写法之一（不要自创格式，不要用通配符）：",
  '{"fetch":[{"op":"list","arg":"D:\\\\workroom"}]}',
  '{"fetch":[{"op":"grep","pattern":"roots","path":"D:\\\\workroom\\\\dsh-auxesis"}]}',
  '{"fetch":[{"op":"read","arg":"D:\\\\workroom\\\\dsh-auxesis\\\\lib\\\\index.js"}]}', 
  "",
  "长度纪律（输出有硬预算，超了会被截断，截断等于整份作废）：preconditions 最多 6 条、chain 最多 5 跳、plan 最多 5 步、assumptions 最多 3 条、extend 最多 3 条；每条字符串不超过 40 个汉字；不要复述题目，不要解释格式。",
  "",
  "只输出 JSON，字段固定：",
  '{"target":string,"success_check":string,"preconditions":[{"item":string,"status":"have|missing|unknown","check":string}],"chain":[{"from":string,"to":string,"why":string,"certain":boolean}],"crux":{"item":string,"why":string},"plan":[{"step":string,"done_when":string}],"assumptions":[{"assumption":string,"falsify":string}],"missing":string|null,"confidence":number}',
  "不要输出 JSON 以外的任何字符，不要用 Markdown 代码块包裹。",
].join("\n");

function userText(args) {
  const lines = ["目标 / 问题：", String(args.problem || "").trim()];
  const focus = String(args.focus || "").trim();
  if (focus) lines.push("", "卡住的位置 / 想从哪儿反推：", focus);
  lines.push("", "按约定只输出 JSON。");
  return lines.join("\n");
}

function parseJson(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const a = raw.indexOf("{");
    const b = raw.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(raw.slice(a, b + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

// ── 自动决策续跑：模型停止输出 → 唤醒它自己填报题面并调用 auxesis ──────────
const IDLE_MS = 3000;
const MAX_WAKES = 5; // 同一会话连续唤醒上限：模型不调 auxesis_done 时也不会无限循环
const watch = new Map(); // sessionId -> { seq, done, wakes }

const WAKE_TEXT = [
  "你停下了。先检查一下还有没有下一步：",
  "· 有：按四段题面自己填（目标 / 现场 / 已试过 / 要什么），然后调用 auxesis（want=judgment）判断下一步并执行；不要把「要接着做吗」抛回给用户。",
  "· 没有（任务已完成，或确实推进不下去）：调用 auxesis_done 标记结束，之后不会再唤醒你。",
].join("\n");

/** 唤醒日志：写进 events.jsonl（tool=wake），便于事后统计触发率与卡住情况 */
function wakeLog(sid, n, kind) {
  try {
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(
      join(dataDir(), "events.jsonl"),
      JSON.stringify({ at: Date.now(), tool: "wake", sessionId: sid, n, kind }) + "\n",
    );
  } catch {
    // 观测失败不拖垮主流程
  }
}

function readSessionEvents(agent) {
  try {
    const s = agent && agent.session;
    if (!s) return [];
    if (Array.isArray(s.events)) return s.events;
    if (typeof s.snapshotEvents === "function") return s.snapshotEvents();
  } catch {
    // 读不到就当没有会话
  }
  return [];
}

function sessionIdOf(agent) {
  try {
    const s = agent && agent.session;
    const h = s && s.header;
    return String(
      (h && (h.id || h.sessionId))
      || (s && s.id)
      || (agent && agent.id)
      || "",
    );
  } catch {
    return "";
  }
}

function recentAgent(agents) {
  const list = typeof agents.roots === "function" ? agents.roots() : (typeof agents.list === "function" ? agents.list() : []);
  let best;
  let bestTime = -1;
  for (const a of list || []) {
    const ev = readSessionEvents(a);
    const last = ev.length ? ev[ev.length - 1] : null;
    // 按最后事件时间选：seq 是会话内自增，跨会话不可比
    const t = last && last.time ? new Date(last.time).getTime() : 0;
    if (t > bestTime) {
      bestTime = t;
      best = a;
    }
  }
  return best;
}

/** 自动决策按会话存：autoSessions[sessionId] === true 才算这个会话开着 */
function autoOf(settings, sid) {
  const map = (settings && settings.current && settings.current.autoSessions) || {};
  return Boolean(sid && map[sid] === true);
}

function currentSessionId(ctx) {
  try {
    const agents = ctx.get("agents", false);
    return agents ? sessionIdOf(recentAgent(agents)) : "";
  } catch {
    return "";
  }
}

function currentAuto(ctx, settings) {
  const sid = currentSessionId(ctx);
  if (sid) return autoOf(settings, sid);
  return Boolean(settings && settings.current && settings.current.autoDecide);
}

async function wakeAgent(agent) {  if (!agent || typeof agent.runMaintenance !== "function" || typeof agent.followup !== "function") return false;
  try {
    const ok = await agent.runMaintenance(async () => {
      agent.followup({
        role: "user",
        id: randomUUID(),
        content: [{ type: "text", text: WAKE_TEXT }],
        source: { kind: "plugin:dsh-auxesis", form: "notice", summary: "自动决策续跑" },
      });
      return true;
    });
    return Boolean(ok);
  } catch {
    return false;
  }
}

export function apply(ctx) {
  const settings = { current: readSettings() };
  const patterns = { list: readPatterns() };
  const playbooks = { list: readPlaybooks() };
  // 运行态：主界面那张状态条读它（本次宿主启动以来的计数）
  const stats = { startedAt: Date.now(), calls: 0, ok: 0, fail: 0, lastMs: 0, lastAt: 0, steps: 0 };
  const disposers = [];
  let disposed = false;

  const guard = (handler) => async (req, res) => {
    try {
      const connection = ctx.get("connection");
      const rejection = connection && typeof connection.requestRejection === "function"
        ? connection.requestRejection(req)
        : undefined;
      if (rejection === 401 || rejection === 403) {
        res.writeHead(rejection, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, error: rejection === 401 ? "authentication_required" : "management_forbidden" }));
        return;
      }
    } catch {
      // 拿不到鉴权信息时放行：设置页宁可可用，也不能因为宿主版本差异而打不开
    }
    return handler(req, res);
  };

  const sendJson = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(obj));
  };

  const readBody = (req) => new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 131072) raw = raw.slice(0, 131072); });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });

  // 本机所有可用路由：provider 列表 + 每个 provider 的模型
  const catalog = async () => {
    const providers = [];
    let list = [];
    try {
      list = ctx.llm?.listProviders?.() || [];
    } catch {
      list = [];
    }
    for (const p of list) {
      const item = { id: p.id, name: p.name || p.id, models: [] };
      try {
        const models = await ctx.llm.listModels?.(p.id);
        for (const m of models || []) item.models.push({ id: m.id, name: m.name || m.id });
      } catch {
        // 某个 provider 的目录拉不出来就跳过，别让整页失败
      }
      providers.push(item);
    }
    return providers;
  };

  // 设置页：读状态
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/dsh-auxesis/state",
    handler: guard(async (_req, res) => {
      try {
        return sendJson(res, 200, {
          ok: true,
          providers: await catalog(),
          settings: settings.current,
          defaults: DEFAULTS,
        });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
      }
    }),
  }));

  // 设置页：保存勾选
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/dsh-auxesis/select",
    handler: guard(async (req, res) => {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      try {
        const body = await readBody(req);
        const incoming = Array.isArray(body.selected) ? body.selected : [];
        const selected = [...new Set(incoming.filter((x) => typeof x === "string" && x.includes("/")))].slice(0, MAX_SELECTED);
        const wantedDefault = typeof body.default === "string" ? body.default : "";
        const room = (value, lo, hi, fallback) => (Number.isFinite(value)
          ? Math.min(hi, Math.max(lo, Math.trunc(value)))
          : fallback);
        const next = {
          ...settings.current,
          selected,
          autoDecide: typeof body.autoDecide === "boolean" ? body.autoDecide : settings.current.autoDecide,
          defaultRoute: selected.includes(wantedDefault) ? wantedDefault : (selected[0] || ""),
          fallbackRoute: selected.includes(String(body.fallbackRoute || "").trim())
            ? String(body.fallbackRoute).trim()
            : "",
          reasoningEffort: typeof body.reasoningEffort === "string"
            ? body.reasoningEffort.trim().slice(0, 40)
            : settings.current.reasoningEffort,
          maxTokens: room(body.maxTokens, 256, 64000, settings.current.maxTokens),
          deadlineMs: room(body.deadlineMs, 5000, 900000, settings.current.deadlineMs),
        };
        writeSettings(next);
        settings.current = next;
        return sendJson(res, 200, { ok: true, settings: next });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
      }
    }),
  }));

  // 主界面状态条：存活 = 本接口在应答；顺带报默认路由、调用次数与经验卡数量
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/dsh-auxesis/status",
    handler: guard(async (_req, res) => {
      try {
        const s = settings.current;
        const provider = String(s.defaultRoute || "").split("/")[0];
        let routeExists = false;
        try {
          routeExists = (ctx.llm.listProviders?.() || []).some((p) => p && p.id === provider);
        } catch {
          routeExists = false;
        }
        return sendJson(res, 200, {
          ok: true,
          alive: true,
          version: VERSION || "unknown",
          route: s.defaultRoute,
          routes: routePlan(settings, ""),
          routeExists,
          selected: s.selected.length,
          calls: stats.calls,
          okCount: stats.ok,
          failCount: stats.fail,
          lastMs: stats.lastMs,
          lastAt: stats.lastAt,
          patterns: patterns.list.length,
          playbooks: playbooks.list.length,
          stepsCalls: stats.steps || 0,
          investigations: stats.investigations || 0,
          uptimeMs: Date.now() - stats.startedAt,
          settingsPath: settingsPath(),
        });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
      }
    }),
  }));

  // 发送栏开关：只改 autoDecide 一个字段，避免前端为了一个开关全量提交勾选
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/dsh-auxesis/auto",
    handler: guard(async (req, res) => {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      try {
        const body = await readBody(req);
        if (typeof body.autoDecide !== "boolean") {
          return sendJson(res, 400, { ok: false, error: "autoDecide 必须是布尔值" });
        }
        const sid = currentSessionId(ctx);
        if (!sid) {
          // 没有活跃会话（冷启动/测试）：退回全局开关
          const next = { ...settings.current, autoDecide: body.autoDecide };
          writeSettings(next);
          settings.current = next;
          return sendJson(res, 200, { ok: true, autoDecide: next.autoDecide, scope: "global" });
        }
        const next = {
          ...settings.current,
          autoSessions: { ...(settings.current.autoSessions || {}), [sid]: body.autoDecide },
        };
        writeSettings(next);
        settings.current = next;
        return sendJson(res, 200, { ok: true, sessionId: sid, autoDecide: body.autoDecide, scope: "session" });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
      }
    }),
  }));

  // 系统提示：放在 order 10 —— 紧跟固定开场白与 persona 之后，
  // 排在 plan/team/工具指导（500 起）之前，成为模型读到的第一段实质指令。
  ctx.inject(["systemPrompt"], (promptCtx) => {
    const section = promptCtx.systemPrompt.section({
      name: "auxesis-first-focus",
      order: 10,
      text: () => {
        const selected = settings.current.selected;
        if (!selected.length) return "";
        const cards = summarizePatterns(patterns.list);
        const books = summarizePlaybooks(playbooks.list);
        return [
          "【回答前的第一判断｜Auxesis 能力增益】可用路由：" + selected.join(" / "),
          "只看一个信号，不看任务类型：这个结论（或这一步操作）要是错了，返工要花超过 10 分钟吗？要，就先问——执行任务同样算：改文件、跑不可逆命令、同一步第二次重试之前。不要（纯查询、一步能确定），直接做。拿不准按「要返工」处理。",
          "「不可逆」单独算一类：删除、覆盖、推送、对外发送、改远端状态——就算一步就能做完，也先问「怎么做才对」。回滚不了的事不赌。",
          ...(currentAuto(ctx, settings)
            ? ["自动决策已开启：可逆的决策（选型、方案取舍、优先级、要不要做某一步）不再问用户，直接调 auxesis（want=judgment）拿结论并执行；结果里的 plan 自己走完，再一次性汇报结论与拓展，不要回头再问一遍。仍然必须问用户：不可逆动作（删除、覆盖、推送、对外发送、改远端状态）、涉及个人偏好或凭据的选择、以及 auxesis 回来时 confidence<0.5 或 missing 非空的判断。题面写清已知现场即可，缺的材料让它自己取（它有 3 次取数预算），不要为了把题面凑完整而先问用户。"]
            : []),
          "按缺什么选，都走同一个入口 auxesis，用 want 说明：缺判断 want=judgment，缺步骤 want=steps；缺材料用 auxesis_investigate。",
          "题面照这个写（对方看不到本会话，写得空，换回来的也空）：",
          "　目标：一句话、可验证；现场：只写此刻成立的，带数字/路径/版本/报错原文；已试过：一句一条；要什么：判断 / 步骤 / 材料。",
          "　例：「目标：两周内把评测从 62 提到 90。现场：每周只有 8 小时、评测本身不能改、62 分的逐题数据还没看。已试过：直接刷题两周，分数没动。要什么：先做哪一步。」",
          "同一问题一次会话只问一次，答案够用就停；结果里的 plan 自己执行，不要再问一遍。",
          ...(cards.length
            ? ["已沉淀的瓶颈模式（过去几次逆向的结论，只作提示，别照搬）："
              + cards.join("；")]
            : []),
          ...(books.length
            ? ["已沉淀的套路（目标 → 常用首步，只作提示）："
              + books.join("；")]
            : []),
        ].join("\n");
      },
    });
    if (typeof section === "function") disposers.push(section);
  });

  // 模型工具
  ctx.inject(["tools"], (toolsCtx) => {
    let stepsRef = null;
    const off = toolsCtx.tools.register({
      name: "auxesis",
      description: [
        "一个入口、两种产出，按 want 选：judgment 从想要的结果反推必要前提，找出卡住最多下游的瓶颈，再给最短正向路径；steps 把目标翻成 1–5 个具体构造（命令 / 配置 / 片段），每步带 expect（怎样算成功）与 if_fails（失败换哪条路）。",
        "判断标准只有一条——这个结论（或这一步操作）错了，是要返工，还是只要动手。缺判断用 judgment；缺能照着做的步骤用 steps。拿不准按会返工处理。",
        "它看不到本会话：judgment 的 problem 必须自包含（目标 + 现场 + 约束）；steps 用 now（此刻成立的事实）/ blocked（卡点 + 原始报错）/ tried / constraints，不要把历史流水贴进来。",
        "返回：judgment → target/success_check/preconditions/chain/crux/decision/plan/extend/assumptions/missing/confidence；steps → read/next[{do,why,expect,if_fails}]/stop/confidence。",
        "route 只能从本机已勾选的路由里选；省略时用默认路由。",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          want: {
            type: "string",
            enum: ["judgment", "steps"],
            description: "judgment = 要判断（缺判断）；steps = 要能照着做的步骤（缺步骤）。",
          },
          problem: {
            type: "string",
            description: "[judgment] 完整的问题陈述：想要的结果、已知条件、约束、已经试过什么。自包含，对方看不到本会话。",
          },
          route: {
            type: "string",
            description: "路由 id，格式 provider/model，例如 z3api/claude-opus-5。只勾选了一条时省略。",
          },
          focus: {
            type: "string",
            description: "[judgment] 可选：当前卡住的位置，或希望从哪里开始反推。",
          },
          goal: { type: "string", description: "[steps] 要达成什么，一句话，可验证。" },
          artifact: {
            type: "string",
            enum: ["command", "config", "procedure"],
            description: "[steps] 产物类型：命令行 / 配置片段 / 操作步骤。",
          },
          now: { type: "string", description: "[steps] 此刻成立的事实：版本、地址端口、路径、已拿到什么。" },
          blocked: { type: "string", description: "[steps] 卡住的那一步 + 原始报错（原样）。" },
          tried: { type: "string", description: "[steps] 已试过且失败的路子，一句一条。" },
          constraints: { type: "string", description: "[steps] 硬约束。" },
          last: {
            type: "object",
            properties: {
              attempt: { type: "string" },
              result: { type: "string" },
              ok: { type: "boolean" },
            },
          },
          steps: { type: "integer", description: "[steps] 想要几步（1–5，默认 3）。" },
          maxFetches: { type: "integer", description: "[judgment] 允许它先要材料的次数（0–2，默认 1）。" },
        },
        required: ["want"],
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render(_args, value) {
          // 特殊标记：模型与人都能一眼看出这段结论来自逆向器，而不是本会话自己推的。
          const isSteps = Boolean(value && value.parsed && Array.isArray(value.parsed.next));
          const stamp = [
            isSteps ? "⟦Auxesis·步骤⟧" : "⟦Auxesis⟧",
            value.route,
            (value.elapsedMs / 1000).toFixed(1) + "s",
            value.truncated ? "已截断" : "完整",
          ].join(" · ");
          return [{ type: "text", text: stamp + "\n" + JSON.stringify(value, null, 2) }];
        },
      },
      async execute(args) {
        const want = args && args.want === "steps" ? "steps" : "judgment";
        if (args && args.want && args.want !== "judgment" && args.want !== "steps") {
          throw new Error("want 只能是 judgment 或 steps。");
        }
        if (want === "steps") {
          if (typeof stepsRef !== "function") throw new Error("steps 模式未就绪：请重载插件。");
          return stepsRef(args);
        }
        if (!args || typeof args.problem !== "string" || !args.problem.trim()) {
          throw new Error("problem 不能为空：请把目标、已知条件与约束写成一段自包含的题面。");
        }
        if (args.route !== undefined && typeof args.route !== "string") {
          throw new Error("route 必须是字符串 provider/model。");
        }
        const roots = settings.current.roots.length ? settings.current.roots : [process.cwd()];
        const budget = Math.min(3, Math.max(0, Number.isFinite(args.maxFetches) ? Math.trunc(args.maxFetches) : 2));
        const messages = [{
          role: "user",
          id: randomUUID(),
          content: [{
            type: "text",
            text: userText(args) + "\n\n可搜目录（取数只能在这些目录内）：\n" + searchScopeText(roots),
          }],
          source: { kind: "plugin", plugin: "dsh-auxesis" },
        }];
        const fetches = [];
        let attempt;
        let text = "";
        let rounds = 0;
        let forced = false;
        for (;;) {
          attempt = await runWithRoutes(ctx, routePlan(settings, String(args.route || "").trim()), {
            system: SYSTEM_PROMPT,
            messages,
            settings,
            stats,
            label: "逆向请求",
            log: { tool: "auxesis", want: "judgment" },
          });
          rounds += 1;
          text = attempt.run.text;
          const peek = parseJson(text);
          const wantsFetch = Boolean(peek && Array.isArray(peek.fetch) && peek.fetch.length > 0);
          if (wantsFetch && fetches.length >= budget && !forced) {
            forced = true;
            messages.push({
              role: "assistant",
              id: randomUUID(),
              content: [{ type: "text", text: String(text).slice(0, 4000) }],
              source: { kind: "plugin", plugin: "dsh-auxesis" },
            });
            messages.push({
              role: "user",
              id: randomUUID(),
              content: [{ type: "text", text: "取数预算已用完。不要再请求 fetch，用现有材料按约定输出最终 JSON。" }],
              source: { kind: "plugin", plugin: "dsh-auxesis" },
            });
            continue;
          }
          if (wantsFetch && fetches.length < budget) {
            const ops = peek.fetch.filter((o) => o && typeof o === "object").slice(0, 3);
            const results = [];
            for (const op of ops) {
              if (fetches.length >= budget) break;
              fetches.push({
                op: String(op.op || ""),
                arg: String(op.arg || ""),
                ...(op.pattern ? { pattern: String(op.pattern) } : {}),
                ...(op.path ? { path: String(op.path) } : {}),
              });
              results.push("【" + String(op.op || "?") + " " + String(op.arg || "") + "】\n" + runFetch(op, roots));
            }
            messages.push({
              role: "assistant",
              id: randomUUID(),
              content: [{ type: "text", text: String(text).slice(0, 4000) }],
              source: { kind: "plugin", plugin: "dsh-auxesis" },
            });
            messages.push({
              role: "user",
              id: randomUUID(),
              content: [{ type: "text", text: "宿主取回的材料：\n\n" + results.join("\n\n") + "\n\n现在按约定只输出最终 JSON。" }],
              source: { kind: "plugin", plugin: "dsh-auxesis" },
            });
            continue;
          }
          break;
        }
        const { run, route, fellBackFrom } = attempt;
        const stop = run.stop;
        const wanted = args.route ? route : "";
        const elapsedMs = run.elapsedMs;

        const parsed = parseJson(text);
        // 工具返回值必须是 lossless JSON：undefined 会被 JSON 序列化丢掉，导致
        // "returned invalid output: value is not lossless JSON"。所以只放有值的字段。
        const result = {
          route,
          routeSource: wanted ? "explicit" : "default",
          ...(fellBackFrom ? { fellBackFrom } : {}),
          ...(rounds > 1 ? { rounds } : {}),
          ...(fetches.length ? { fetches } : {}),
          elapsedMs,
          truncated: Boolean(stop && stop.kind === "max-tokens"),
        };
        if (parsed !== undefined && parsed !== null) {
          result.parsed = parsed;
          // 预算用完还在要材料：明确标出来，别让调用方把 fetch 请求当成结论
          if (!parsed.crux && Array.isArray(parsed.fetch) && parsed.fetch.length) {
            result.phase = "fetch-unanswered";
          }
        } else {
          result.parsed = null;
          result.raw = text.slice(0, 4000);
          result.note = result.truncated
            ? "输出被 maxTokens（" + settings.current.maxTokens + "）截断，JSON 不完整；raw 是原文。调大预算或把题面收窄后再试。"
            : "上游没有给出可解析的 JSON，raw 里是原文。";
        }
        // 沉淀经验：成功解析才记，失败/截断不记（免得把半截结论当成模式）
        if (result.parsed) {
          const card = distill(result);
          if (card) {
            const list = patterns.list;
            const hit = list.find((x) => x.c === card.c && x.t === card.t);
            if (hit) {
              hit.n = (hit.n || 1) + 1;
              hit.at = Date.now();
            } else {
              list.push({ ...card, n: 1, at: Date.now() });
            }
            patterns.list = list;
            try {
              writePatterns(list);
            } catch {
              // 写盘失败不影响本次结论
            }
          }
        }
        logEvent({
          at: Date.now(),
          tool: "auxesis",
          want: "judgment",
          route,
          fallback: fellBackFrom || null,
          autoDecide: Boolean(settings.current.autoDecide),
          ok: Boolean(result.parsed),
          kind: result.parsed ? "ok" : (result.truncated ? "truncated" : "parse"),
          rounds,
          fetches: fetches.length,
          elapsedMs,
          truncated: result.truncated,
          confidence: result.parsed && typeof result.parsed.confidence === "number" ? result.parsed.confidence : null,
          missing: result.parsed && result.parsed.missing ? String(result.parsed.missing).slice(0, 120) : null,
          crux: result.parsed && result.parsed.crux && result.parsed.crux.item ? String(result.parsed.crux.item).slice(0, 60) : null,
          phase: result.phase || null,
        });
        stats.ok += 1;
        stats.lastMs = result.elapsedMs;
        stats.lastAt = Date.now();
        return result;
      },
    });
    if (typeof off === "function") disposers.push(off);

    // ── steps 模式：由 auxesis 的 want=steps 转发进来，不再单独注册工具
    const runSteps = async (args) => {
        if (!args || typeof args.goal !== "string" || !args.goal.trim()) {
          throw new Error("goal 不能为空：用一句话写清要达成什么。");
        }
        if (typeof args.state !== "string" || !args.state.trim()) {
          const hasStructured = [args.now, args.blocked, args.tried, args.constraints]
            .some((x) => typeof x === "string" && x.trim());
          if (!hasStructured) {
            throw new Error(
              "现场不能为空：至少给 now（此刻成立的事实）或 blocked（卡在哪一步 + 原始报错）。"
              + "历史流水不要贴，写当前就够。",
            );
          }
        }
        if (args.route !== undefined && typeof args.route !== "string") {
          throw new Error("route 必须是字符串 provider/model。");
        }
        stats.steps += 1;
        const attempt = await runWithRoutes(ctx, routePlan(settings, String(args.route || "").trim()), {
          system: STEPS_PROMPT,
          user: stepsUserText(args),
          settings,
          stats,
          label: "构造请求",
          log: { tool: "auxesis", want: "steps" },
        });
        const { run } = attempt;
        const parsed = parseJson(run.text);
        const result = {
          route: attempt.route,
          routeSource: args.route ? "explicit" : "default",
          ...(attempt.fellBackFrom ? { fellBackFrom: attempt.fellBackFrom } : {}),
          elapsedMs: run.elapsedMs,
          truncated: Boolean(run.stop && run.stop.kind === "max-tokens"),
        };
        if (parsed !== undefined && parsed !== null) {
          result.parsed = parsed;
          // 套路沉淀：只记成功解析的第一步，供下一次先自己走
          const card = distillPlaybook(args, parsed);
          if (card) {
            const list = playbooks.list;
            const hit = list.find((x) => x.g === card.g && x.s === card.s);
            if (hit) hit.n = (hit.n || 1) + 1;
            else list.push({ ...card, n: 1, at: Date.now() });
            playbooks.list = list;
            try {
              writePlaybooks(list);
            } catch {
              // 写盘失败不影响本次结论
            }
          }
        } else {
          result.parsed = null;
          result.raw = run.text.slice(0, 4000);
          result.note = result.truncated
            ? "输出被 maxTokens（" + settings.current.maxTokens + "）截断，JSON 不完整；raw 是原文。"
            : "上游没有给出可解析的 JSON，raw 里是原文。";
        }
        logEvent({
          at: Date.now(),
          tool: "auxesis",
          want: "steps",
          route: attempt.route,
          fallback: attempt.fellBackFrom || null,
          autoDecide: Boolean(settings.current.autoDecide),
          ok: Boolean(result.parsed),
          kind: result.parsed ? "ok" : (result.truncated ? "truncated" : "parse"),
          rounds: null,
          fetches: 0,
          elapsedMs: result.elapsedMs,
          truncated: result.truncated,
          confidence: result.parsed && typeof result.parsed.confidence === "number" ? result.parsed.confidence : null,
          missing: null,
          crux: result.parsed && typeof result.parsed.read === "string" ? String(result.parsed.read).slice(0, 60) : null,
          phase: null,
        });
        stats.ok += 1;
        stats.lastMs = result.elapsedMs;
        stats.lastAt = Date.now();
        return result;
    };
    stepsRef = runSteps;

    // ── auxesis_investigate：允许它自己回环境取材料（只读、限定目录、最多 3 次）
    const offInv = toolsCtx.tools.register({
      name: "auxesis_investigate",
      description: [
        "当答案要靠现场里的具体内容才能定、而你不想把原材料灌进自己的上下文时，用它：它可以要求宿主去 read / tail / grep / list，最多 3 次，拿到材料后自己下结论；也可以附图片。",
        "判断标准只有一条——这条答案是不是必须读到文件、日志或一屏截图才能定。必须读就用它；题面里已经写着的，不必再取。拿不准时按「必须读」处理。",
        "它只读、不执行、不联网，也看不到本会话：goal 写要弄清什么，state 写已知与禁区，images 附图片路径（必须在允许目录内）。返回 JSON：parsed（答案）+ fetches（它取过什么）。",
        "route 只能从本机已勾选的路由里选；省略时用默认路由。",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "要弄清什么，一句话，可验证。" },
          state: { type: "string", description: "现场：环境、已知条件、已经排除的可能、禁区。" },
          images: {
            type: "array",
            items: { type: "string" },
            description: "可选：要给它看的图片路径，必须在允许的目录内（png/jpg/webp/gif）。",
          },
          maxFetches: { type: "integer", description: "取数次数上限（0–3，默认 3）。" },
          route: { type: "string", description: "路由 id，provider/model；省略时用默认路由。" },
        },
        required: ["goal", "state"],
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render(_args, value) {
          const stamp = [
            "⟦Auxesis·调查⟧",
            value.route,
            (value.elapsedMs / 1000).toFixed(1) + "s",
            "取数 " + (Array.isArray(value.fetches) ? value.fetches.length : 0) + " 次",
            value.truncated ? "已截断" : "完整",
          ].join(" · ");
          return [{ type: "text", text: stamp + "\n" + JSON.stringify(value, null, 2) }];
        },
      },
      async execute(args) {
        if (!args || typeof args.goal !== "string" || !args.goal.trim()) {
          throw new Error("goal 不能为空：一句话写清要弄清什么。");
        }
        if (typeof args.state !== "string" || !args.state.trim()) {
          throw new Error("state 不能为空：至少写清环境与已知条件。");
        }
        const roots = settings.current.roots.length ? settings.current.roots : [process.cwd()];
        const budget = Math.min(3, Math.max(0, Number.isFinite(args.maxFetches) ? Math.trunc(args.maxFetches) : 3));
        let routes = routePlan(settings, String(args.route || "").trim());
        let activeRoute = routes[0];

        const images = Array.isArray(args.images) ? args.images.filter((x) => typeof x === "string") : [];
        let imageBlocks = [];
        if (images.length) {
          const loaded = await loadImageParts(ctx, images, roots);
          if (loaded.error) {
            throw new Error(loaded.error + "（允许的目录：" + roots.join("；") + "）");
          }
          imageBlocks = loaded.blocks || [];
        }

        const messages = [{
          role: "user",
          id: randomUUID(),
          content: [{
            type: "text",
            text: investigateUserText(args, budget) + "\n\n可搜目录（取数只能在这些目录内）：\n" + searchScopeText(roots),
          }, ...imageBlocks],
          source: { kind: "plugin", plugin: "dsh-auxesis" },
        }];
        const fetches = [];
        let parsed;
        let elapsedMs = 0;
        let truncated = false;
        let rounds = 0;
        stats.investigations = (stats.investigations || 0) + 1;

        let forced = false;
        while (rounds <= budget + 2) {
          const attempt = await runWithRoutes(ctx, routes, {
            system: INVESTIGATE_PROMPT,
            messages,
            settings,
            stats,
            label: "调查请求",
            log: { tool: "investigate", want: null },
          });
          const run = attempt.run;
          if (attempt.fellBackFrom) { routes = [attempt.route]; activeRoute = attempt.route; }
          rounds += 1;
          elapsedMs += run.elapsedMs;
          truncated = truncated || Boolean(run.stop && run.stop.kind === "max-tokens");
          const p = parseJson(run.text);
          const wantsFetch = Boolean(p && Array.isArray(p.fetch) && p.fetch.length > 0);
          if (wantsFetch && fetches.length < budget) {
            const ops = p.fetch.filter((o) => o && typeof o === "object").slice(0, 4);
            const results = [];
            for (const op of ops) {
              if (fetches.length >= budget) break;
              fetches.push({ op: String(op.op || ""), arg: String(op.arg || "") });
              results.push("【" + String(op.op || "?") + " " + String(op.arg || "") + "】\n" + runFetch(op, roots));
            }
            messages.push({
              role: "assistant",
              id: randomUUID(),
              content: [{ type: "text", text: String(run.text).slice(0, 4000) }],
              source: { kind: "plugin", plugin: "dsh-auxesis" },
            });
            messages.push({
              role: "user",
              id: randomUUID(),
              content: [{ type: "text", text: "宿主取回的材料：\n\n" + results.join("\n\n") }],
              source: { kind: "plugin", plugin: "dsh-auxesis" },
            });
            continue;
          }
          if (wantsFetch && !forced) {
            // 预算用完还在要材料：给一次强制收尾的机会，而不是把 fetch 当成结论返回
            forced = true;
            messages.push({
              role: "assistant",
              id: randomUUID(),
              content: [{ type: "text", text: String(run.text).slice(0, 4000) }],
              source: { kind: "plugin", plugin: "dsh-auxesis" },
            });
            messages.push({
              role: "user",
              id: randomUUID(),
              content: [{
                type: "text",
                text: "取数预算已用完（" + fetches.length + "/" + budget
                  + "）。不要再请求 fetch，用已经拿到的材料作答，只输出 {\"answer\":{...}}。",
              }],
              source: { kind: "plugin", plugin: "dsh-auxesis" },
            });
            continue;
          }
          parsed = p;
          break;
        }

        const answer = parsed && typeof parsed === "object" && parsed.answer ? parsed.answer : parsed;
        const result = {
          route: activeRoute,
          routeSource: args.route ? "explicit" : "default",
          rounds,
          fetches,
          elapsedMs,
          truncated,
        };
        if (answer !== undefined && answer !== null && typeof answer === "object") {
          result.parsed = answer;
          if (!answer.crux && parsed && parsed.fetch) result.phase = "fetch-unanswered";
        } else {
          result.parsed = null;
          result.note = fetches.length
            ? "取数预算用完后仍没有给出 answer；可以把 maxFetches 调到 3，或把 goal 写得更具体。"
            : "上游没有给出可解析的 JSON。";
        }
        logEvent({
          at: Date.now(),
          tool: "investigate",
          want: null,
          route: activeRoute,
          fallback: null,
          autoDecide: Boolean(settings.current.autoDecide),
          ok: Boolean(result.parsed) && result.phase !== "fetch-unanswered",
          kind: result.phase === "fetch-unanswered" ? "fetch-unanswered" : (result.parsed ? "ok" : "parse"),
          rounds,
          fetches: fetches.length,
          elapsedMs,
          truncated,
          confidence: result.parsed && typeof result.parsed.confidence === "number" ? result.parsed.confidence : null,
          missing: null,
          crux: result.parsed && result.parsed.crux && result.parsed.crux.item ? String(result.parsed.crux.item).slice(0, 60) : null,
          phase: result.phase || null,
        });
        stats.ok += 1;
        stats.lastMs = elapsedMs;
        stats.lastAt = Date.now();
        return result;
      },
    });
    if (typeof offInv === "function") disposers.push(offInv);

    // 结束标记：模型认为任务完成/彻底卡住时调用，停止自动续跑
    try {
      const offDone = toolsCtx.tools.register({
        name: "auxesis_done",
        description:
          "标记当前任务结束。自动决策开启时，你停止输出会被唤醒续跑；若你已完成任务或彻底无法继续，调用它停止续跑。",
        parameters: {
          type: "object",
          properties: {
            reason: { type: "string", description: "一句话说明为什么结束（可选）。" },
          },
          required: [],
        },
        output: {
          schema: { type: "object", additionalProperties: true },
          render(_args, value) {
            const sid = value && value.sessionId ? String(value.sessionId).slice(0, 8) : "";
            return [{ type: "text", text: "已标记任务结束" + (sid ? "（会话 " + sid + "）" : "") + "，自动决策不会再唤醒它。" }];
          },
        },
        async execute(args) {
          const agents = ctx.get("agents", false);
          const agent = agents ? recentAgent(agents) : undefined;
          const sid = sessionIdOf(agent);
          if (sid) {
            const st = watch.get(sid) || { seq: 0, done: false };
            st.done = true;
            watch.set(sid, st);
          }
          return {
            ok: true,
            sessionId: sid || null,
            reason: String((args && args.reason) || "").slice(0, 200),
          };
        },
      });
      if (typeof offDone === "function") disposers.push(offDone);
    } catch (e) {
      // 结束工具注册失败不影响 auxesis 主工具
      try {
        appendFileSync(join(dataDir(), "errors.log"), new Date().toISOString() + " auxesis_done register failed: " + String((e && e.message) || e) + "\n");
      } catch {
        // 日志写失败就算了
      }
    }
  });

  // 自动决策续跑：模型停止输出 → 唤醒它自己填报题面并调用 auxesis
  try {
    ctx.effect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      const agents = ctx.get("agents", false);
      if (!agents) return;
      const list =
        typeof agents.roots === "function"
          ? agents.roots()
          : typeof agents.list === "function"
            ? agents.list()
            : [];

      for (const a of list || []) {
        const sid = sessionIdOf(a);
        // 自动决策是会话级的：只处理本会话开了开关的那些
        if (!sid || !autoOf(settings, sid)) continue;
        const ev = readSessionEvents(a);
        const last = ev.length ? ev[ev.length - 1] : null;
        if (!last) continue;
        const type = String(last.type || "");

        // 真实用户消息到达：重置，允许重新触发
        if (/^(user|input)\/message$/.test(type)) {
          const src = last.data && last.data.source;
          const fromPlugin = Boolean(src && String(src.kind || "").startsWith("plugin:"));
          if (!fromPlugin) {
            watch.delete(sid);
            continue;
          }
        }

        const st = watch.get(sid) || { seq: 0, done: false, wakes: 0 };
        // turn/end 才是轮次真正结束的权威事件；assistant/message 只是中间输出
        const isEnd = /^turn\/end$/.test(type);
        if (isEnd && !st.done && Number(last.seq) > st.seq) {
          const seq = Number(last.seq);
          if ((st.wakes || 0) >= MAX_WAKES) {
            st.seq = seq;
            watch.set(sid, st);
            wakeLog(sid, st.wakes, "capped");
            continue;
          }
          // 不 await：busy 由 runMaintenance 抛错判定，失败就下个 tick 重试
          wakeAgent(a).then((ok) => {
            if (!ok) return;
            st.seq = seq;
            st.wakes = (st.wakes || 0) + 1;
            watch.set(sid, st);
            wakeLog(sid, st.wakes, "ok");
          }).catch(() => {});
          watch.set(sid, st);
        } else {
          watch.set(sid, st);
        }
      }
    };
    const timer = setInterval(tick, IDLE_MS);
    // 不阻止进程退出（测试/宿主卸载时都能干净结束）
    if (typeof timer.unref === "function") timer.unref();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    });
  } catch (e) {
    // 观察器启动失败不影响插件其他部分
    try {
      appendFileSync(join(dataDir(), "errors.log"), new Date().toISOString() + " observer start failed: " + String((e && e.message) || e) + "\n");
    } catch {
      // 日志写失败就算了
    }
  }

  ctx.logger?.info?.("dsh-auxesis: loaded (settings=" + settingsPath() + ")");

  return () => {
    disposed = true;
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 宿主卸载中，失败不值得再抛
      }
    }
    return disposed;
  };
}
