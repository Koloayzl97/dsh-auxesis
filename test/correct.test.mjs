// 纠偏纯函数层回归：会话读取、硬信号抽取、逐字校验、notice 格式。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractHardSignals,
  noticeMessage,
  quoteIsVerbatim,
  renderHardSignals,
  sessionEvents,
  sourceTextOf,
  verifyCards,
} from "../lib/correct.mjs";

const ev = (type, data, seq) => ({ type, seq, time: "2026-11-22T00:00:00Z", data });

test("sessionEvents：优先 session.events，否则走 snapshotEvents()", () => {
  assert.equal(sessionEvents({ session: { events: [1, 2] } }).length, 2);
  assert.equal(sessionEvents({ session: { snapshotEvents: () => [1, 2, 3] } }).length, 3);
  assert.deepEqual(sessionEvents({}), []);
  assert.deepEqual(sessionEvents(null), []);
});

test("extractHardSignals：抽用户原话、失败原文、重复动作", () => {
  const events = [
    ev("user/message", { text: "这个模型一直修不好我的 VPN" }, 1),
    ev("assistant/message", { text: "我先改 MTU" }, 2),
    ev("tool/call", { tool: "bash", args: { cmd: "ipsec restart" } }, 3),
    ev("tool/call", { tool: "bash", args: { cmd: "ipsec restart" } }, 4),
    ev("tool/call", { tool: "bash", args: { cmd: "ipsec restart" } }, 5),
    ev("tool/result", { error: "ipsec 握手超时" }, 6),
    ev("assistant/message", { text: "再试一次" }, 7),
  ];
  const hard = extractHardSignals(events);
  assert.deepEqual(hard.user, ["这个模型一直修不好我的 VPN"]);
  assert.equal(hard.lastAssistant, "再试一次");
  assert.equal(hard.repeats.length, 1);
  assert.equal(hard.repeats[0].n, 3);
  assert.match(hard.repeats[0].call, /ipsec restart/);
  assert.equal(hard.errors.length, 1);
  assert.match(hard.errors[0], /握手超时/);
});

test("verifyCards：非逐字引文被丢弃，逐字的保留", () => {
  const source = "ipsec 握手超时\n这个模型一直修不好我的 VPN";
  const out = verifyCards(
    {
      cards: [
        { id: "F1", kind: "user", quote: "这个模型一直修不好我的 VPN", why: "用户原话" },
        { id: "F2", kind: "fail", quote: "握手超时（我补的）", why: "编造" },
        { id: "F3", kind: "fail", quote: "ipsec 握手超时", why: "失败原文" },
      ],
    },
    source,
  );
  assert.equal(out.cards.length, 2);
  assert.equal(out.cards[0].quote, "这个模型一直修不好我的 VPN");
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].reason, "not-verbatim");
});

test("quoteIsVerbatim：纯空白与过短引文不算数", () => {
  assert.equal(quoteIsVerbatim("握手超时", "ipsec 握手超时"), true);
  assert.equal(quoteIsVerbatim("   ", "ipsec 握手超时"), false);
  assert.equal(quoteIsVerbatim("超", "ipsec 握手超时"), false);
});

test("renderHardSignals / sourceTextOf：备注与硬信号都进材料与校验源", () => {
  const hard = extractHardSignals([
    ev("user/message", { text: "一直修不好 VPN" }, 1),
    ev("tool/call", { tool: "bash", args: { cmd: "restart" } }, 2),
    ev("tool/call", { tool: "bash", args: { cmd: "restart" } }, 3),
  ]);
  const material = renderHardSignals(hard, "别改 MTU 了");
  assert.match(material, /别改 MTU 了/);
  assert.match(material, /一直修不好 VPN/);
  assert.match(material, /n=2/);

  const source = sourceTextOf(hard, "别改 MTU 了");
  assert.equal(quoteIsVerbatim("一直修不好 VPN", source), true);
});

test("noticeMessage：v4 producer-owned source 与可读摘要", () => {
  const msg = noticeMessage("turn", [{ kind: "repeat", quote: "restart ×3", why: "重复动作 ×3" }]);
  assert.equal(msg.kind, "plugin:dsh-auxesis");
  assert.equal(msg.form, "notice");
  assert.match(msg.summary, /方向可能跑偏/);
  assert.match(msg.summary, /重复动作/);
});
