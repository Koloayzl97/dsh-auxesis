// dsh-auxesis 事件汇总：读 events.jsonl，按工具 / 结果 / 自动决策开关分组统计。
//   node scripts/summary.mjs
// 只读本地文件，零依赖，不联网、不调用模型。
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 宿主进程不一定带 DSH_PROFILE_DIR，所以两个候选都探一遍，谁能读到日志就用谁
const candidates = [];
if (process.env.DSH_PROFILE_DIR) candidates.push(join(process.env.DSH_PROFILE_DIR, "data", "dsh-auxesis"));
candidates.push(join(homedir(), ".dsh", "dsh-auxesis"));
const dir = candidates.find((d) => existsSync(join(d, "events.jsonl"))) || candidates[0];
const file = join(dir, "events.jsonl");

if (!existsSync(file)) {
  console.log("没有事件日志：" + file);
  console.log("先调用几次 auxesis / auxesis_investigate，日志会自己长出来。");
  process.exit(0);
}

const events = readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const group = (fn) => {
  const m = new Map();
  for (const e of events) {
    const k = fn(e);
    if (!k) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

const okCount = events.filter((e) => e.ok).length;
const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);

console.log("事件总数 " + events.length + "   成功 " + okCount + " / 失败 " + (events.length - okCount));
const first = events[0] && events[0].at;
const last = events.at(-1) && events.at(-1).at;
if (first && last) console.log("覆盖时间 " + ((last - first) / 3600000).toFixed(1) + " 小时");

console.log("\n按工具：");
for (const [k, v] of group((e) => e.tool + (e.want ? "/" + e.want : ""))) console.log("  " + k.padEnd(20) + v);

console.log("\n按结果：");
for (const [k, v] of group((e) => e.kind || (e.ok ? "ok" : "?"))) console.log("  " + k.padEnd(20) + v);

console.log("\n自动决策开关：");
for (const side of ["开", "关"]) {
  const sub = events.filter((e) => (e.autoDecide ? "开" : "关") === side);
  if (!sub.length) continue;
  const low = sub.filter((e) => typeof e.confidence === "number" && e.confidence < 0.5).length;
  console.log("  " + side + "：" + sub.length + " 次，平均 " + avg(sub.map((e) => e.elapsedMs || 0)) + "ms，低置信 " + low);
}

const withConf = events.filter((e) => typeof e.confidence === "number");
if (withConf.length) {
  const low = withConf.filter((e) => e.confidence < 0.5).length;
  console.log("\n低置信（<0.5）：" + low + " / " + withConf.length + " 次带置信度");
}
const unanswered = events.filter((e) => e.phase === "fetch-unanswered").length;
if (unanswered) console.log("取数预算耗尽仍未作答：" + unanswered + " 次");

const recent = events.slice(-10);
console.log("\n最近 " + recent.length + " 条：");
for (const e of recent) {
  const t = e.at ? new Date(e.at).toLocaleTimeString("zh-CN", { hour12: false }) : "--:--:--";
  console.log("  " + t + "  " + (e.tool || "?") + (e.want ? "/" + e.want : "") + "  " + (e.kind || "") + "  " + (e.elapsedMs || 0) + "ms" + (e.crux ? "  " + e.crux : ""));
}
