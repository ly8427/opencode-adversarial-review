// =============================================================================
// core.mjs — 共享核心（Claude Code 适配层用；OpenCode 插件 adversarial-review.js 不依赖本文件）
// -----------------------------------------------------------------------------
// 本文件实现四个已核实缺陷的修复形态：
//   缺陷① 审阅输入只有最后一条回答      → context pack（被审回答 + 本轮用户原话 + 可选证据）
//   缺陷② 结果绑定"最后一条用户消息 ID" → 版本绑定：sha256(回答全文) 作为去重/冷却键
//   缺陷③ 反馈注入失败会中止用户原会话  → 本核心从不拥有任何外部会话句柄，失败只丢自己的结果
//   缺陷④ 纯内存状态集合脆弱            → 任务模型 + 原子持久化 + 内容哈希去重 + 冷却期
//
// 设计约束（与既有决策一致）：
//   - 零依赖（node: 内置模块），node >= 18
//   - 不引入数据库/队列；状态 = state.json（原子写）+ history.jsonl（追加）
//   - 反馈轮次固定 1 轮（钩子侧由 stop_hook_active 强制；不做成配置，避免虚假可调）
//   - "无实质问题"(no_material_findings) 是合法成功结果，不是失败
// =============================================================================

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ===== 默认配置 =====
// mode: "manual" = 仅手动命令审阅（默认；收尾钩子零开销退出）
//       "auto"   = 收尾钩子自动审（显式开启；L1 粗筛 + 哈希冷却挡噪音与成本）
export const DEFAULT_CONFIG = {
  enabled: true,
  mode: "manual",
  // 冷审阅后端：外部 claude --bare 进程（真冷：无记忆/无插件发现/无工具）。
  // 实际派生命令 = reviewerCommand + 固定安全参数（见 reviewer.mjs reviewerArgs）
  reviewerCommand: "claude",
  // 追加到审阅命令的额外参数（如 --fallback-model）
  reviewerArgs: [],
  // 审阅用模型（--model）；undefined = 用 claude 默认。可与主会话不同（如主 sonnet / 审 opus）
  reviewModel: undefined,
  // 审阅硬超时（毫秒）。到点杀审阅子进程、丢弃本次结果、放行主会话——绝不让用户等死
  reviewTimeoutMs: 120000,
  // 同一回答内容（哈希相同）审阅完成后的冷却期；期内同内容不重审。内容一变立即视为新版本
  cooldownMs: 30 * 60 * 1000,
  // 审阅失败后的重试冷却（固定 5 分钟，防止每轮都烧一次失败的审阅成本）
  failureCooldownMs: 5 * 60 * 1000,
  // opt-out 标记（本轮用户提词命中 → 跳过）：与 OpenCode 插件同款语义
  skipPattern: "\\[(skip|noreview|debug)\\]",
  // opt-in 白名单：设了则只有用户提词命中才自动审；undefined = 不启用
  reviewPattern: undefined,
  // L1 粗筛最短长度（与 OpenCode 插件同值）
  minAnswerLen: 60,
  // 自动审时附带 git 证据摘要（diff --stat + status，截断 4KB）；默认关
  includeGitEvidence: false,
};

// ===== 配置加载：项目 .adversarial-review.json > 全局 ~/.adv-review/config.json > 默认 =====
// env.ADV_REVIEW_CONFIG 可显式指定配置文件（测试与多配置场景的逃生门）
export function resolveConfigFile(cwd = process.cwd(), env = process.env) {
  if (env.ADV_REVIEW_CONFIG) return env.ADV_REVIEW_CONFIG;
  const project = path.join(cwd, ".adversarial-review.json");
  try {
    if (fs.existsSync(project)) return project;
  } catch { /* ignore */ }
  const global = path.join(os.homedir(), ".adv-review", "config.json");
  try {
    if (fs.existsSync(global)) return global;
  } catch { /* ignore */ }
  return null;
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function loadConfig(cwd = process.cwd(), env = process.env) {
  const config = { ...DEFAULT_CONFIG };
  const file = resolveConfigFile(cwd, env);
  let raw = null;
  if (file) {
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      // 配置文件损坏不致命：退回默认值，但在 stderr 留痕（钩子 stdout 是决策契约，日志只走 stderr）
      process.stderr.write(`[adv-review] config parse failed (${file}): ${e?.message || e}\n`);
      raw = null;
    }
  }
  if (isPlainObject(raw)) {
    for (const key of Object.keys(config)) {
      if (!(key in raw)) continue;
      const v = raw[key];
      switch (typeof config[key]) {
        case "boolean":
          if (typeof v === "boolean") config[key] = v;
          break;
        case "number":
          if (typeof v === "number" && Number.isFinite(v) && v >= 0) config[key] = v;
          break;
        case "string":
          if (typeof v === "string" || v === undefined) config[key] = v;
          break;
        default:
          // 数组 / undefined 默认值：reviewerArgs 数组、reviewModel/reviewPattern undefined
          if (Array.isArray(config[key]) && Array.isArray(v)) config[key] = v.map(String);
          else if (config[key] === undefined && (typeof v === "string" || v === null)) config[key] = v === null ? undefined : v;
          break;
      }
    }
    // 未知键留痕（不致命）
    for (const key of Object.keys(raw)) {
      if (!(key in DEFAULT_CONFIG)) {
        process.stderr.write(`[adv-review] unknown config key ignored: ${key}\n`);
      }
    }
  }
  // mode 容错：hybrid 是 auto 的别名（历史讨论用词），非法值一律退 manual
  if (config.mode === "hybrid") config.mode = "auto";
  if (config.mode !== "manual" && config.mode !== "auto") config.mode = "manual";
  config.configFile = file;
  return config;
}

// ===== L1 本地粗筛（从 OpenCode 插件逐字移植，语义保持一致：recall-bias） =====
const ACK_WORDS = ["已提交", "已部署", "已修复", "已更新", "done", "Done", "完成", "committed", "tests pass", "Tests pass"];
const CONCLUSION_WORDS = [
  "决定", "最终", "结论", "建议", "方案", "上线",
  "recommend", "should", "plan", "decision", "conclusion",
];

const hasConclusion = (txt) =>
  CONCLUSION_WORDS.some((w) => {
    const re = /[A-Za-z]/.test(w) ? new RegExp("\\b" + w + "\\b", "i") : new RegExp(w, "i");
    return re.test(txt);
  });

export function localFilter(text, { minAnswerLen = 60 } = {}) {
  if (!text || typeof text !== "string") return { pass: false, reason: "empty" };
  const strippedLen = text.replace(/\s/g, "").length;
  if (strippedLen < minAnswerLen) {
    if (ACK_WORDS.some((w) => text.includes(w))) return { pass: false, reason: `short+ack (len=${strippedLen})` };
    if (!hasConclusion(text)) return { pass: false, reason: `too short no-conclusion (len=${strippedLen})` };
  }
  const fences = (text.match(/```/g) || []).length;
  if (fences >= 2 && !hasConclusion(text)) {
    return { pass: false, reason: `code-heavy no-conclusion (fences=${fences})` };
  }
  return { pass: true };
}

// ===== skip / 白名单正则（与 OpenCode 插件同语义：skip 优先，白名单是额外授权门） =====
export function compilePatterns(config) {
  let skipRe = null;
  let reviewRe = null;
  try {
    if (config.skipPattern) skipRe = new RegExp(config.skipPattern, "i");
  } catch (e) {
    process.stderr.write(`[adv-review] bad skipPattern: ${e?.message || e}\n`);
  }
  try {
    if (config.reviewPattern) reviewRe = new RegExp(config.reviewPattern, "i");
  } catch (e) {
    process.stderr.write(`[adv-review] bad reviewPattern: ${e?.message || e}\n`);
  }
  return { skipRe, reviewRe };
}

export function shouldSkipByPattern({ title = "", userText = "" }, { skipRe, reviewRe }) {
  if (skipRe && ((title && skipRe.test(title)) || (userText && skipRe.test(userText)))) {
    return { skip: true, reason: "skip marker" };
  }
  if (reviewRe && !reviewRe.test(title || "") && !reviewRe.test(userText || "")) {
    return { skip: true, reason: "not in review whitelist" };
  }
  return { skip: false };
}

// ===== 版本绑定：sha256(回答全文) =====
export function answerHash(text) {
  return createHash("sha256").update(text == null ? "" : String(text).trim(), "utf8").digest("hex");
}
export const hash8 = (h) => (h || "").slice(0, 8);

// ===== 结果规范化：审阅器输出契约 =====
// 契约：{verdict: "material_findings"|"no_material_findings", findings: [{severity, confidence, finding, evidence, impact, recommendation}]}
// - 解析失败 → parse_error（按无发现处理 + 留痕；绝不因解析失败阻断用户会话）
// - findings 非空但无 verdict → 推断 material_findings；空 findings 无 verdict → no_material_findings
const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const clamp01 = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
};

export function extractJsonBlock(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch { /* fall through */ }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function normalizeFindings(rawText) {
  const obj = extractJsonBlock(rawText);
  if (!isPlainObject(obj)) {
    return { verdict: "parse_error", findings: [], parseError: "output is not a JSON object" };
  }
  let findings = [];
  if (Array.isArray(obj.findings)) {
    findings = obj.findings.filter(isPlainObject).map((f) => ({
      severity: SEVERITIES.has(String(f.severity || "").toLowerCase()) ? String(f.severity).toLowerCase() : "medium",
      confidence: clamp01(f.confidence),
      finding: String(f.finding ?? "").trim(),
      evidence: String(f.evidence ?? "").trim(),
      impact: String(f.impact ?? "").trim(),
      recommendation: String(f.recommendation ?? "").trim(),
    })).filter((f) => f.finding.length > 0);
  } else if (obj.findings !== undefined) {
    return { verdict: "parse_error", findings: [], parseError: "findings is not an array" };
  }
  let verdict = obj.verdict;
  if (verdict !== "material_findings" && verdict !== "no_material_findings") {
    verdict = findings.length > 0 ? "material_findings" : "no_material_findings";
  }
  // 自洽修正：声明无发现却带 findings → 信 findings；声明有发现却空 → 信 verdict 为空结果
  if (verdict === "no_material_findings" && findings.length > 0) verdict = "material_findings";
  if (verdict === "material_findings" && findings.length === 0) verdict = "no_material_findings";
  return { verdict, findings };
}

// ===== 钩子路径的审阅超时上限（Bugbot #fb14c942）=====
// hooks.json 给钩子的预算是 180 秒；reviewTimeoutMs 配得比它大时，宿主会先杀钩子，
// 内部超时永远不触发、任务卡 reviewing。钩子入口据此把实际审阅超时截到预算内
// （留 10 秒给 stdin 读取/进程派生/状态写盘）；CLI 路径无宿主天花板，不受此限。
export const HOOK_TIMEOUT_BUDGET_MS = 170000;

// ===== 状态存储 =====
// 状态目录：env.ADV_STATE_DIR（逃生门/测试）> ~/.adv-review/state/<项目路径哈希>
export function stateDirFor(cwd = process.cwd(), env = process.env) {
  if (env.ADV_STATE_DIR) return env.ADV_STATE_DIR;
  const proj = answerHash(path.resolve(cwd)).slice(0, 12);
  return path.join(os.homedir(), ".adv-review", "state", proj);
}

const FRESH_STATE = () => ({ tasks: {}, reviewedByHash: {} });

export function loadState(dir) {
  const file = path.join(dir, "state.json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return FRESH_STATE();
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    // 损坏恢复：隔离坏文件，从零开始（任务记录属诊断性质，丢得起；history.jsonl 不受影响）
    try {
      fs.renameSync(file, path.join(dir, `state.json.corrupt-${Date.now()}`));
    } catch { /* ignore */ }
    return FRESH_STATE();
  }
  if (!isPlainObject(obj) || !isPlainObject(obj.tasks)) return { ...FRESH_STATE() };
  return {
    tasks: obj.tasks,
    reviewedByHash: isPlainObject(obj.reviewedByHash) ? obj.reviewedByHash : {},
  };
}

export function saveStateAtomic(dir, state) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "state.json");
    const tmp = path.join(dir, `state.json.tmp-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, file); // libuv 在 Windows 上以 MOVEFILE_REPLACE_EXISTING 语义 rename，可覆盖
    return true;
  } catch (e) {
    process.stderr.write(`[adv-review] saveState failed: ${e?.message || e}\n`);
    return false;
  }
}

// 任务模型：独立 ID、绑定会话与回答版本、状态机 pending→reviewing→done|failed|skipped
export function createTask(state, { sessionId = null, turn = null, answerHash: hash, trigger = "manual" }) {
  const id = `adv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  // 每会话只保留最新一个活跃任务：同会话旧的 pending/reviewing 一律标记 skipped（ superseded ）
  for (const t of Object.values(state.tasks)) {
    if (sessionId && t.sessionId === sessionId && (t.status === "pending" || t.status === "reviewing")) {
      t.status = "skipped";
      t.skippedReason = "superseded-by-latest";
      t.finishedAt = new Date().toISOString();
    }
  }
  const task = {
    id,
    sessionId,
    turn,
    answerHash: hash,
    trigger,
    status: "reviewing",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    findingsCount: null,
  };
  state.tasks[id] = task;
  return task;
}

export function finishTask(state, id, { status, error = null, findingsCount = null, durationMs = null }) {
  const t = state.tasks[id];
  if (!t) return;
  t.status = status;
  t.finishedAt = new Date().toISOString();
  t.error = error;
  t.findingsCount = findingsCount;
  t.durationMs = durationMs;
  if (status === "done") {
    state.reviewedByHash[t.answerHash] = { at: t.finishedAt, ok: true, taskId: id, findingsCount };
  } else if (status === "failed") {
    state.reviewedByHash[t.answerHash] = { at: t.finishedAt, ok: false, taskId: id, findingsCount: null };
  }
}

// 去重/冷却判定：同哈希在审 → 跳；同哈希 recently done → 冷却跳；同哈希 recently failed → 短冷却跳；否则审
// 在途判定有时效（Bugbot #34b4c951）：钩子进程死于审阅中途（宿主超时杀钩子/Esc/崩溃/断电）会留下
// 永远 reviewing 的任务，把同一回答的自动审阅永久堵死。陈旧任务一律标记 failed（放行重审），不视为在途。
export function staleReviewTtlMs(config) {
  return Math.max(config.reviewTimeoutMs || 120000, 60000) + 60000;
}

// 把超过时效的 reviewing 任务标记为 failed；返回清理数量（幂等，可重复调用）
export function sweepStaleReviewing(state, config, now = Date.now()) {
  const ttl = staleReviewTtlMs(config);
  let swept = 0;
  for (const t of Object.values(state.tasks)) {
    if (t.status !== "reviewing") continue;
    const started = Date.parse(t.startedAt);
    const age = Number.isFinite(started) ? now - started : Infinity;
    if (age >= ttl) {
      t.status = "failed";
      t.error = "stale reviewing task — hook process died mid-review";
      t.finishedAt = new Date(now).toISOString();
      swept++;
    }
  }
  return swept;
}

export function shouldReview(state, { answerHash: hash, sessionId = null }, config) {
  sweepStaleReviewing(state, config); // 在途判定前先清陈旧（幂等）
  for (const t of Object.values(state.tasks)) {
    if (t.status === "reviewing" && t.answerHash === hash && (!sessionId || !t.sessionId || t.sessionId === sessionId)) {
      return { review: false, reason: "same answer in-flight" };
    }
  }
  const rec = state.reviewedByHash[hash];
  if (rec) {
    const at = Date.parse(rec.at);
    if (Number.isFinite(at)) {
      const age = Date.now() - at;
      const cooldown = rec.ok ? config.cooldownMs : (config.failureCooldownMs || 5 * 60 * 1000);
      if (age < cooldown) {
        return { review: false, reason: rec.ok ? "cooldown (same answer recently reviewed)" : "failure cooldown" };
      }
    }
  }
  return { review: true };
}

// ===== history.jsonl（追加；诊断用，丢得起） =====
export function appendHistory(dir, record) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "history.jsonl"), JSON.stringify(record) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

export function readHistory(dir, limit = 20) {
  try {
    const raw = fs.readFileSync(path.join(dir, "history.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const out = [];
    for (const line of lines.slice(-limit)) {
      try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
    }
    return out;
  } catch {
    return [];
  }
}

// ===== transcript 读取（best-effort，全部 try/catch；失败返回 null，不影响主流程） =====
// Claude Code transcript 为 JSONL；条目形如 {type:"user"|"assistant", message:{role, content: string | [{type:"text",text}]}}
// 注入的审阅反馈会以 user 身份出现在 transcript，识别标志是文本以【对抗性审阅】开头——跳过之。
const INJECTED_MARK = "【对抗性审阅】";

function textFromMessageContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n")
      .trim();
  }
  return "";
}

function readTranscriptEntries(transcriptPath) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      entries.push(JSON.parse(t));
    } catch { /* 坏行跳过 */ }
  }
  return entries;
}

export function lastUserQuestionFromTranscript(transcriptPath) {
  const entries = readTranscriptEntries(transcriptPath);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const role = e?.message?.role || (e?.type === "user" ? "user" : null);
    if (role !== "user") continue;
    if (e.isMeta) continue;
    const text = textFromMessageContent(e?.message?.content);
    if (!text) continue;
    if (text.startsWith(INJECTED_MARK)) continue;
    return text;
  }
  return null;
}

export function lastAssistantFromTranscript(transcriptPath) {
  const entries = readTranscriptEntries(transcriptPath);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const role = e?.message?.role || (e?.type === "assistant" ? "assistant" : null);
    if (role !== "assistant") continue;
    const text = textFromMessageContent(e?.message?.content);
    if (text) return text;
  }
  return null;
}

// ===== 反馈格式化（钩子 block reason 与 CLI 输出共用） =====
export function formatFindings({ findings, answerHash: hash = null, durationMs = null, forHook = false }) {
  const head = forHook
    ? "【对抗性审阅】独立审阅者（无任何对话历史与工具）对上面的回答提出以下问题。\n"
      + "请逐条回应：**接受并修改** / **给出依据反驳** / 或标注 **待验证**（说明需要什么证据才能定论）。\n"
      + "回应完所有条目后再结束本回合。不要为了省事整体接受或整体驳回。\n"
    : "对抗性审阅结果：\n";
  const meta = [];
  if (hash) meta.push(`审阅对象版本: ${hash8(hash)}`);
  if (Number.isFinite(durationMs)) meta.push(`审阅用时: ${(durationMs / 1000).toFixed(1)}s`);
  const lines = [];
  let i = 1;
  for (const f of findings) {
    const conf = f.confidence === null || f.confidence === undefined ? "" : ` | 置信 ${f.confidence}`;
    lines.push(`\n${i}. [${f.severity}${conf}] ${f.finding}`);
    if (f.evidence) lines.push(`   依据: ${f.evidence}`);
    if (f.impact) lines.push(`   影响: ${f.impact}`);
    if (f.recommendation) lines.push(`   建议: ${f.recommendation}`);
    i++;
  }
  const metaLine = meta.length ? `\n（${meta.join(" | ")}）\n` : "";
  return head + metaLine + lines.join("\n");
}
