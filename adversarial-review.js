// =============================================================================
// adversarial-review.js — opencode plugin (cold-agent adversarial review)
// -----------------------------------------------------------------------------
// 当 opencode 会话产出"重要结论"时,自动建一个**新 session**(无历史=冷)做
// 对抗性审阅,把审阅意见注入回原 session,逼原 agent 当场回应。
//
// 冷审阅全程用 opencode 原生 session.create + session.prompt,不 spawn 任何
// 外部 CLI。部署只需把本文件放到 ~/.config/opencode/plugins/ (无 root)。
//
// 核对依据:2026-08 opencode dev 分支生成类型 + 源码(经四轮 review 核实)。
// 服务器上以 node_modules/@opencode-ai/sdk 实际安装版本的类型为准。
//
// 已核实的源码事实(见 README-DEPLOY.md "观察项"):
//   - event hook 是 fire-and-forget:不阻塞事件总线(无死锁),但错误不被框架吞 → 必须 try/catch
//   - ⚠ idle 转变会同时 publish session.status(idle) 和 session.idle 两个事件 → 只能监听一个,
//     否则 fire-and-forget 并发下必双触发/死循环(见下方 triggerEvent 配置)
//   - tools:{"*":false} 才是"禁用所有工具";tools:{} 是 no-op
//   - prompt 的 system 是"追加"在 AGENTS.md 之后(非覆盖),审阅者人设排最后靠位置压制
//   - 同步 session.prompt 直接返回 {info, parts},info.parentID = 触发它的那条 user 消息 ID
//   - session.status 端点 path 为 never,返回全量 {[id]:SessionStatus} map(不能传 path)
//   - app.log 必填 service+level+message
//   - task 工具建的子 session 带 parentID;fork 的不带(仍会被审)
// =============================================================================

// ===== 配置(可按需改) =====
const CONFIG = {
  enabled: true,

  // 触发事件:opencode 一次 idle 转变会同时发 session.status(idle) 和 session.idle 两个事件
  // (源码 status.ts),fire-and-forget 并发下两个都听 = 必然双触发/死循环。
  // 只能二选一。默认 "session.status"(非 deprecated);若该版本不发,改 "session.idle"。
  triggerEvent: "session.status",

  // 审阅用模型;undefined = 用 opencode 当前默认模型。
  reviewModel: undefined,

  // 【实验选项 · 默认关闭】审阅 session 的工作目录。
  // undefined = 默认(会加载当前项目 AGENTS.md,审阅者被轻微预热,靠 system 追加压制)
  // 设为项目外路径(如 "/tmp")= 意图让审阅 session 不加载项目 AGENTS.md,更冷。
  //   ⚠ 跨目录建 session 再 prompt 的路由行为未在源码完全钉死,实测通过后再启用。
  reviewDirectory: undefined,

  // 审阅者人设(作为 prompt 的 system 追加;排最后,靠位置压制 AGENTS.md)
  reviewSystemPrompt:
    "你是严格的对抗性审阅者,没有看过之前的对话。只基于下面这条结论,挑战其假设、指出风险、逻辑漏洞和遗漏的边界情况,给出具体反驳,不要客套,不要附和。",

  // 审阅 prompt 超时(毫秒)。超时则 abort 审阅 session 并清理,避免 inFlight 永久残留。
  reviewTimeoutMs: 5 * 60 * 1000,

  // 【per-session / per-turn 控制】标题或当前轮用户提词命中此正则 → 跳过本次审阅。
  //   会话级:给 session 标题加标记(如 "[debug] 排障")→ 该会话全程不审
  //   单轮级:在某次提问里加标记(如 "快速看下这个bug [noreview]")→ 仅这一轮不审
  // 改标记词直接改这个正则;默认匹配 [skip]/[noreview]/[debug]。
  skipPattern: "\\[(skip|noreview|debug)\\]",

  // 【opt-in 白名单】设了才生效:设了之后,只有标题或当前轮提词命中此正则,才触发审阅;
  // 否则即使重要结论也跳过(默认从"全审"切到"只在白名单内审")。与 skipPattern 共存:
  // skip 优先(命中必跳),白名单是额外授权门。默认 undefined = 不启用(维持全审)。
  // 例: reviewPattern: "review|important|\u5ba1\u4e00\u4e0b" → 只审标题/提词含这些词的。
  reviewPattern: undefined,
};

// =============================================================================
// 防循环 / 防重入状态
// =============================================================================
// selfCreated: 我们 create 的冷审阅 sessionID(idle 时一律跳过)
// inFlight:    正在审阅的原 sessionID(必须在第一个 await 之前置位,堵并发双触发的 TOCTOU)
// justInjected: Map<原sessionID, 注入消息所触发 assistant 的 parentID>
//   语义:刚把审阅注入原 session,记录"续写回合那条 assistant 的 parentID"。
//   续写回合 idle 时,拉最后一条 user 消息,若其 id === 记录的 parentID → 这是审阅续写,跳过(不删);
//   不匹配 → 新一轮用户结论,清标记继续审。
//   (parentID = 触发 assistant 的那条 user 消息 id,源码 prompt.ts: parentID = lastUser.id)
//   比对法即使双事件/事件乱序也绝不会误审续写回合,且不需要 TTL。
// 预编译跳过标记正则(per-session/per-turn 控制)
const SKIP_RE = new RegExp(CONFIG.skipPattern, "i");
// opt-in 白名单正则;reviewPattern 为 undefined 时不启用(REVIEW_RE=null,维持全审)
const REVIEW_RE = CONFIG.reviewPattern ? new RegExp(CONFIG.reviewPattern, "i") : null;

const selfCreated = new Set();
const inFlight = new Set();
const justInjected = new Map();

// =============================================================================
// plugin 主体
// =============================================================================
export default async function AdvReview({ client }) {
  // 日志:app.log 必填 service+level+message;await+catch 吞 promise rejection(不抛 unhandled)
  // ⚠ 绝不 console.log:opencode 是 TUI 应用,任何 stdout 写入都会污染屏幕渲染
  // (残留为鬼影,正是之前误判为"审阅回填"的元凶)。日志只走 app.log 进 opencode 日志文件;
  // 需要本地调试时设 ADV_DEBUG_FILE=/path/to.log,写文件(不污染 TUI)。
  const log = (...args) => {
    const line = "[adv-review] " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    client
      .app.log({ body: { service: "adv-review", level: "info", message: line } })
      .catch(() => {});
    if (process.env.ADV_DEBUG_FILE) {
      try { require("fs").appendFileSync(process.env.ADV_DEBUG_FILE, line + "\n"); } catch {}
    }
  };

  log("plugin loaded; enabled=" + CONFIG.enabled + " trigger=" + CONFIG.triggerEvent);

  // --- 从 {info, parts} 提取 assistant 文本(排除 synthetic/ignored) ---
  const extractAssistantText = (entry) => {
    if (!entry || entry.info.role !== "assistant") return null;
    const t = entry.parts
      .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
      .map((p) => p.text)
      .join("\n")
      .trim();
    return t || null;
  };

  // --- Layer 1 本地过滤(recall-bias:短且无结论词→跳过;有结论词→放行) ---
  const localFilter = (text) => {
    const minLen = 60;
    const ackWords = ["已提交", "已部署", "已修复", "已更新", "done", "Done", "完成", "committed", "tests pass", "Tests pass"];
    const conclusionWords = ["决定", "最终", "结论", "建议", "方案", "上线", "recommend", "should", "plan", "decision", "conclusion"];
    const minFences = 2;
    // 中文词原样匹配;英文词加 \b 词边界,挡住子串误匹配(如 "running" 含 "run")。
    // 注:"will" 过弱("OK, will do." 也会触发),已从结论词移除(早期 review 指出)。
    const hasConcl = (txt) =>
      conclusionWords.some((w) => {
        const re = /[A-Za-z]/.test(w) ? new RegExp("\\b" + w + "\\b", "i") : new RegExp(w, "i");
        return re.test(txt);
      });

    const strippedLen = text.replace(/\s/g, "").length;
    // 短消息:命中 ack → skip;无结论词 → skip(挡住"你好/谢谢");有结论词 → 放行(recall)
    if (strippedLen < minLen) {
      if (ackWords.some((w) => text.includes(w))) return { pass: false, reason: `short+ack (len=${strippedLen})` };
      if (!hasConcl(text)) return { pass: false, reason: `too short no-conclusion (len=${strippedLen})` };
    }
    const fences = (text.match(/```/g) || []).length;
    if (fences >= minFences && !hasConcl(text)) {
      return { pass: false, reason: `code-heavy no-conclusion (fences=${fences})` };
    }
    return { pass: true };
  };

  // --- 带超时 + 真取消的 prompt(审阅 & 注入共用) ---
  // AbortController:signal 透传给 client.session.prompt 的底层 fetch,超时 controller.abort() 真取消。
  // (旧实现用 Promise.race:超时只放弃等待、不取消 fetch → 连接泄漏。)
  const promptWithTimeout = async (id, body) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.reviewTimeoutMs);
    try {
      return await client.session.prompt({ path: { id }, body, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    event: async ({ event }) => {
      // ⚠ fire-and-forget:handler 抛错 = unhandled rejection(框架不吞),必须全局兜底
      try {
        if (!CONFIG.enabled) return;

        // session.error:主动清标记,防止异常后标记残留
        if (event.type === "session.error") {
          const sid = event.properties?.sessionID;
          if (sid) {
            justInjected.delete(sid);
            inFlight.delete(sid);
            log("cleared flags on session.error:", sid);
          }
          return;
        }

        // 触发点:只听配置的那一个事件(默认 session.status 的 idle)。绝不同时听两个。
        // (源码 status.ts:idle 转变会同时 publish session.status 和 session.idle,两个都听 = 必双触发)
        const isIdle =
          CONFIG.triggerEvent === "session.idle"
            ? event.type === "session.idle"
            : event.type === "session.status" && event.properties?.status?.type === "idle";
        if (!isIdle) return;

        const sid = event.properties.sessionID;

        // ① 自建审阅 session 跳过
        if (selfCreated.has(sid)) return;
        // ③ 防重入:正在审阅的 session 跳过
        if (inFlight.has(sid)) return;
        // 【关键】inFlight 必须在任何 await 之前置位,堵住并发双触发的 TOCTOU 窗口
        inFlight.add(sid);
        let reviewSessionID; // 提升到外层,finally 才能在所有路径(含超时/失败 return)统一清理
        try {
          // ② 防循环:刚注入审阅 → 比对 parentID,判断本轮 idle 是不是"审阅续写"
          if (justInjected.has(sid)) {
            const injectedParentID = justInjected.get(sid);
            // 拉最后一条 user 消息,比对 id
            const msgsResp0 = await client.session.messages({ path: { id: sid } });
            const msgs0 = msgsResp0.data || [];
            const lastUser = [...msgs0].reverse().find((m) => m.info.role === "user");
            if (lastUser && lastUser.info.id === injectedParentID) {
              // 这就是审阅触发的续写回合 → 跳过,但保留标记(下次新结论时再清)
              return;
            }
            // 不是续写(用户发了新消息)→ 清标记,正常往下审
            justInjected.delete(sid);
          }

          // 只审主 session:子 agent session(有 parentID)跳过;fork 的不带 parentID 仍被审
          const sessResp = await client.session.get({ path: { id: sid } });
          const session = sessResp.data;
          if (!session) return;
          if (session.parentID) {
            log("skip child session:", sid, "parent=", session.parentID);
            return;
          }

          // 会话级跳过:标题命中标记 → 该 session 全程不审
          if (session.title && SKIP_RE.test(session.title)) {
            log("skip by title marker:", sid, session.title);
            return;
          }

          // 拉消息,取最后一条 assistant 文本(数组升序,末尾是最新)
          const msgsResp = await client.session.messages({ path: { id: sid } });
          const msgs = msgsResp.data || [];
          const lastAssistant = [...msgs].reverse().find((m) => m.info.role === "assistant");
          const text = extractAssistantText(lastAssistant);
          if (!text) return;

          // 单轮级跳过:当前轮用户提词命中标记 → 仅这一轮不审
          //   (排除 synthetic:我们注入的审阅不算用户提词)
          const lastUserEntry = [...msgs].reverse().find((m) => m.info.role === "user");
          const lastUserText = lastUserEntry
            ? lastUserEntry.parts.filter((p) => p.type === "text" && !p.synthetic && !p.ignored).map((p) => p.text).join("\n").trim()
            : "";
          if (lastUserText && SKIP_RE.test(lastUserText)) {
            log("skip by prompt marker:", sid);
            return;
          }

          // opt-in 白名单:设了 reviewPattern 时,标题或当前轮提词命中才审;
          // 都不命中 → 跳过(默认从"全审"切到"白名单内审")。skip 优先级已在上面处理。
          if (REVIEW_RE && !REVIEW_RE.test(session.title || "") && !REVIEW_RE.test(lastUserText)) {
            log("skip: not in review whitelist", sid);
            return;
          }

          // 记下触发本次审阅的 user 消息 id:注入前要比对它,若用户在冷审阅窗口内发了新消息
          // (最后一条 user 变了)→ 放弃注入,避免"针对旧结论 C 的审阅错位打到新消息 M 上下文"。
          const triggerUserID = lastUserEntry ? lastUserEntry.info.id : null;

          // Layer 1 本地过滤(零成本)
          const fr = localFilter(text);
          if (!fr.pass) {
            log("skip L1:", sid, fr.reason);
            return;
          }

          // 注入前查 status:端点 path 为 never,返回全量 map,按 sid 取
          const stResp = await client.session.status();
          if (stResp.data?.[sid]?.type === "busy") {
            log("skip busy:", sid);
            return;
          }

          // ===== 冷审阅:建新 session(无历史=冷) =====
          const created = await client.session.create({
            body: { title: "adv-review-cold" },
            ...(CONFIG.reviewDirectory ? { query: { directory: CONFIG.reviewDirectory } } : {}),
          });
          reviewSessionID = created.data?.id;
          if (!reviewSessionID) throw new Error("session.create returned no id");
          selfCreated.add(reviewSessionID);
          log("cold session created:", reviewSessionID, "for", sid);

          // 同步 prompt:system 放审阅者人设(追加在 AGENTS.md 后),parts 放被审结论;
          // tools:{"*":false} 禁用所有工具,让审阅一步完成、不读不改文件
          let reviewResp;
          try {
            reviewResp = await promptWithTimeout(reviewSessionID, {
              system: CONFIG.reviewSystemPrompt,
              parts: [{ type: "text", text: text }],
              tools: { "*": false },
              ...(CONFIG.reviewModel ? { model: CONFIG.reviewModel } : {}),
            });
          } catch (e) {
            // 审阅超时/失败:fire-and-forget abort 服务端轮(不 await —
            // await 在挂起时不返回 → finally 延迟 → inFlight 锁死。controller.abort 已取消客户端 fetch)
            log("review failed/timeout:", e?.message || String(e));
            client.session.abort({ path: { id: reviewSessionID } }).catch(() => {});
            return;
          }

          const reviewText = (reviewResp.data?.parts || [])
            .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
            .map((p) => p.text)
            .join("\n")
            .trim();

          if (!reviewText) {
            log("skip: empty review for", sid);
            return;
          }

          // ===== 注入回原 session =====
          // 先治"错位":若冷审阅窗口内用户发了新消息(最后一条 user id ≠ triggerUserID),
          // 放弃本次注入——避免针对旧结论 C 的审阅错位打到新消息 M 的上下文。
          // (注意:这只治错位,救不回"M 的结论被 inFlight 防重入挡掉漏审"——那是已知边界。)
          {
            const recheck = await client.session.messages({ path: { id: sid } });
            const nowLastUser = [...(recheck.data || [])].reverse().find((m) => m.info.role === "user");
            if (triggerUserID && nowLastUser && nowLastUser.info.id !== triggerUserID) {
              log("skip inject: user moved on during review (stale conclusion)", sid);
              return;
            }
          }

          // 注入也是完整 LLM 轮(触发 assistant 续写),用 promptWithTimeout 封顶(现含真取消)。
          // 失败则 fire-and-forget abort sid(不 await,同审阅超时,避免挂起卡 finally)。
          let injectResp;
          try {
            injectResp = await promptWithTimeout(sid, {
              parts: [{ type: "text", text: "【对抗性审阅】\n" + reviewText, synthetic: true }],
            });
          } catch (e) {
            log("inject failed/timeout, fire-and-forget abort sid:", sid, e?.message || String(e));
            client.session.abort({ path: { id: sid } }).catch(() => {});
            return;
          }
          const triggerParentID = injectResp.data?.info?.parentID;
          if (triggerParentID) justInjected.set(sid, triggerParentID);
          log("review injected into", sid, `(${reviewText.length} chars, parentID=${triggerParentID})`);

        } finally {
          // 无论成败(含超时/失败 return 路径):清 in-flight;删除审阅 session 并从 Set 移除
          inFlight.delete(sid);
          if (reviewSessionID) {
            try { await client.session.delete({ path: { id: reviewSessionID } }); } catch { /* ignore */ }
            selfCreated.delete(reviewSessionID);
          }
        }
      } catch (err) {
        // fire-and-forget 兜底:任何异常都吃掉记日志,绝不抛成 unhandled rejection
        try {
          log("ERROR:", err?.message || String(err));
        } catch {}
      }
    },
  };
}
