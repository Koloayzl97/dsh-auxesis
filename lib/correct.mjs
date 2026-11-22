// 纠偏链路的纯函数层：会话事件读取、硬信号抽取、事实卡校验、notice 消息构造。
// 不依赖宿主服务，便于 node 直接单测；跨文件只 import node: 内置模块。

/** 从 agent 读事件：live agent 优先 session.events，其次 snapshotEvents()（proactive 的 sessionLogOf 同款） */
export function sessionEvents(agent) {
  try {
    const s = agent && agent.session;
    if (!s) return [];
    if (Array.isArray(s.events)) return s.events;
    if (typeof s.snapshotEvents === "function") return s.snapshotEvents();
  } catch {
    // 读不到就当空会话，纠偏走降级
  }
  return [];
}

const str = (v) => (typeof v === "string" ? v : "");
const clip = (v, n) => str(v).replace(/\s+/g, " ").trim().slice(0, n);

function textIn(d) {
  return str(d.text) || str(d.content) || str(d.message) || str(d.summary);
}

/**
 * 硬信号：用户原话、错误原文、重复动作、最后一条助手回复。
 * 这些绝不交给模型改写——计数和原文一旦被平滑，纠偏就失去依据。
 */
export function extractHardSignals(events, opts = {}) {
  const maxEvents = Number.isFinite(opts.maxEvents) ? opts.maxEvents : 20000;
  const maxUser = Number.isFinite(opts.maxUser) ? opts.maxUser : 6;
  const maxErrors = Number.isFinite(opts.maxErrors) ? opts.maxErrors : 6;

  const user = [];
  const errors = [];
  const repeats = [];
  const types = {};
  const calls = new Map();
  let lastAssistant = "";

  let scanned = 0;
  for (const e of events || []) {
    if (scanned++ >= maxEvents) break;
    const type = str(e && e.type);
    if (!type) continue;
    types[type] = (types[type] || 0) + 1;

    const d = e && e.data;
    if (!d || typeof d !== "object") continue;

    // 用户消息：不同版本的落盘类型名可能不同，全都认
    if (/^(user|input)\/message$/.test(type) || /user.*message/i.test(type)) {
      const t = clip(textIn(d), 500);
      if (t) user.push(t);
      continue;
    }
    // 助手回复：只留最后一条，作为“当前方向”的客观记录
    if (/assistant\/message$/.test(type) || /assistant.*message/i.test(type)) {
      const t = clip(textIn(d), 800);
      if (t) lastAssistant = t;
      continue;
    }
    // 工具调用：按 tool + 参数计数，重复两次以上是“在原地打转”的硬证据
    if (/tool\/(call|start)$/.test(type) || /^tool[-_]call$/.test(type)) {
      const tool = str(d.tool) || str(d.name) || str(d.toolName) || "?";
      const args = d.args ?? d.arguments ?? d.input ?? "";
      const key = tool + "|" + (typeof args === "string" ? args : JSON.stringify(args)).slice(0, 300);
      calls.set(key, (calls.get(key) || 0) + 1);
      continue;
    }
    // 工具结果：只收失败/报错
    if (/tool\/(result|end|error)$/.test(type) || /tool[-_]result/i.test(type)) {
      const dump = JSON.stringify(d).slice(0, 800);
      if (/error|failed|失败|not found|exit code [1-9]|timed out|timeout/i.test(dump)) {
        errors.push(dump);
      }
      continue;
    }
    // 工作区变更：改了什么文件也是方向信号
    if (/workspace\/changes$/.test(type)) {
      const dump = JSON.stringify(d).slice(0, 400);
      if (dump && dump !== "{}") types["workspace/changes:payload"] = (types["workspace/changes:payload"] || 0) + 1;
    }
  }

  for (const [key, n] of calls) {
    if (n >= 2) repeats.push({ call: key, n });
  }
  repeats.sort((a, b) => b.n - a.n);

  return {
    user: user.slice(-maxUser),
    errors: errors.slice(-maxErrors),
    repeats: repeats.slice(0, 6),
    lastAssistant: lastAssistant.slice(0, 800),
    types,
  };
}

/** 引文必须是原文子串——防编造的最后一道闸，机器层面可判 */
export function quoteIsVerbatim(quote, source) {
  const q = clip(quote, 300);
  if (q.length < 2) return false;
  return str(source).includes(q);
}

/**
 * 校验 haiku 产出的卡片：逐张验引文、限数量与长度；不合格直接丢弃并计数。
 * 硬信号卡（lock=true）不经过这里，由代码直接生成。
 */
export function verifyCards(raw, sourceText, opts = {}) {
  const maxCards = Number.isFinite(opts.maxCards) ? opts.maxCards : 8;
  const maxQuote = Number.isFinite(opts.maxQuote) ? opts.maxQuote : 200;
  const cards = [];
  const rejected = [];
  const list = raw && Array.isArray(raw.cards) ? raw.cards : [];

  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    const quote = clip(c.quote, maxQuote);
    const kind = str(c.kind) || "state";
    if (!quote) {
      rejected.push({ reason: "empty-quote", kind });
      continue;
    }
    if (!quoteIsVerbatim(quote, sourceText)) {
      rejected.push({ reason: "not-verbatim", kind, quote: quote.slice(0, 60) });
      continue;
    }
    cards.push({
      id: str(c.id) || "F" + (cards.length + 1),
      kind: ["user", "fail", "repeat", "state", "noise"].includes(kind) ? kind : "state",
      quote,
      src: clip(c.src, 80),
      why: clip(c.why, 80),
      n: Number.isFinite(c.n) ? Math.trunc(c.n) : undefined,
      locked: false,
    });
    if (cards.length >= maxCards) break;
  }
  return { cards, rejected, filtered: true };
}

/** 把硬信号渲染成给底模的材料（只喂信号，不喂全量事件） */
export function renderHardSignals(hard, note) {
  const lines = [];
  if (str(note).trim()) lines.push("用户备注：" + clip(note, 300));
  if (hard.user.length) {
    lines.push("", "用户原话（由代码从会话抽取，未改写）：");
    for (const t of hard.user) lines.push("- " + t);
  }
  if (hard.repeats.length) {
    lines.push("", "重复动作（代码计数，n 为出现次数）：");
    for (const r of hard.repeats) lines.push("- n=" + r.n + " " + r.call);
  }
  if (hard.errors.length) {
    lines.push("", "失败原文（代码截取）：");
    for (const t of hard.errors) lines.push("- " + t);
  }
  if (hard.lastAssistant) {
    lines.push("", "最后一条助手回复（客观记录，不代表正确）：", hard.lastAssistant);
  }
  if (!lines.length) lines.push("（会话里没抽到可用信号）");
  return lines.join("\n");
}

/** 底模材料的总文本，供逐字校验比对 */
export function sourceTextOf(hard, note) {
  return [str(note), ...hard.user, ...hard.repeats.map((r) => r.call), ...hard.errors, hard.lastAssistant].join("\n");
}

/** 纠偏结论回流给主模型时的消息（v4 producer-owned source） */
export function noticeMessage(verdict, cards) {
  const head = verdict === "turn" ? "方向可能跑偏" : "方向基本正确";
  const lines = ["⟦Auxesis·纠偏⟧ " + head];
  if (cards.length) {
    lines.push("", "客观信号：");
    for (const c of cards) lines.push("- [" + c.kind + "] " + c.why + "：" + c.quote);
  }
  return {
    kind: "plugin:dsh-auxesis",
    form: "notice",
    summary: lines.join("\n").slice(0, 4000),
  };
}
