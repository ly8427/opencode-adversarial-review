# Adversarial Review Plugin — opencode 部署指南

opencode 原生冷 agent 对抗性审阅:会话产出"重要结论"时,自动建一个新 session(无历史=冷)做对抗性审阅,把意见注入回原 session 逼原 agent 回应。全程 opencode 原生 API,不依赖任何外部 CLI。

- **适用**:无 root 的 Linux 服务器,给你自己的所有 opencode 会话用
- **冷审阅方式**:opencode 原生新 session(`session.create` + `session.prompt`)
- **核对依据**:2026-08 opencode dev 分支生成类型 + 源码(经三轮 review 核实)。服务器上以 `node_modules/@opencode-ai/sdk` 实际安装版本的类型为准

---

## 一、部署(无 root,全程用户目录)

```bash
# 1. 把 adversarial-review.js 放到全局 plugin 目录(对所有会话生效)
mkdir -p ~/.config/opencode/plugins
cp adversarial-review.js ~/.config/opencode/plugins/

# 2. 无需改 opencode.json —— 本地 plugin 放进 plugins/ 目录即自动加载
#    (只有 npm 包才需要在 config 的 "plugin" 数组里声明)

# 3. (可选)确认 opencode 自身的 SDK 位置(故障排查时定位类型用;plugin 本身不 import SDK,
#    client 由 opencode 运行时注入,这步查不到也不影响加载)
find ~/.cache/opencode ~/.config/opencode -path '*@opencode-ai/sdk*/dist/client.d.ts' 2>/dev/null | head -1

# 4. 重启 opencode,plugin 自动加载
```

卸载:删掉 `~/.config/opencode/plugins/adversarial-review.js` 重启即可。

---

## 二、分步验证(每步独立,失败不崩主进程)

> plugin 默认 `ADV_DEBUG` 开启,日志走 `client.app.log`(进 opencode 日志体系)+ `console.log` 双路。验证期建议另开一个终端:
> ```bash
> tail -f ~/.local/share/opencode/log/*.log 2>/dev/null || tail -f ~/.local/state/opencode/log/*.log 2>/dev/null
> ```
> (日志路径以你的 opencode 版本为准;console 输出也会出现在启动 opencode 的终端)

### 步骤 1:加载验证
启动 opencode。日志里应出现:
```
[adv-review] plugin loaded; enabled=true
```
没出现 → 见故障排查"plugin 没加载"。出现但后面报错 → 进步骤 2 看具体错。

### 步骤 2:本地过滤验证(零成本拦截,顺带验 idle 触发)
发一条普通短消息,比如 `你好`。等回复结束,日志应出现:
```
[adv-review] skip L1: <sid> too short no-conclusion (len=...)
```
说明 Layer 1 拦截生效,**没有**起冷 session(省钱),也证明 idle 事件被正确监听。

### 步骤 3:ack 过滤验证
发一条纯状态消息,比如 `已完成`。日志应出现:
```
[adv-review] skip L1: <sid> short+ack (len=...)
```
同样不触发审阅。

### 步骤 4:冷审阅验证(核心)
发一条带明确结论的消息,让 opencode 产出类似架构决策的回复。比如:
> 帮我决定用 Redis 还是本地内存字典做缓存,给我最终结论和上线计划

opencode 回复后,日志应依次出现:
```
[adv-review] cold session created: <reviewSid> for <sid>
[adv-review] review injected into <sid> (NNNN chars, parentID=<msgID>)
```
并且**原会话里会出现「【对抗性审阅】」开头的续写**——原 agent 正在回应审阅意见。

### 步骤 5:防循环验证(最关键)
盯紧步骤 4 之后:续写回应审阅 → 结束 → 日志**不应**再出现 `cold session created`。
- 若只续写了一轮就停 → 防循环工作正常 ✅(靠 parentID 比对:续写回合的 user 消息 id === 注入时记录的 parentID → 被识别为审阅续写并跳过)
- 若 `cold session created` 反复出现(审阅→续写→又审→又续写…) → **立即 Ctrl+C 停止**,在 CONFIG 里设 `enabled:false`,上报日志(见故障排查"循环")

**无残留验证**:跑 2-3 次审阅后,确认审阅 session 被清理(不留常驻)。

优先用 SDK(会话存储路径随 opencode 版本变化,文件系统命令可能查不到):
```bash
# 在 opencode TUI 里或用 SDK 调:list 出的 session 里不应有 title === "adv-review-cold" 的项
# 也可临时在 plugin 里加一行:client.session.list().then(r => log("sessions:", r.data?.length))
```
或参考文件系统(opencode 存储路径以你的版本为准,dev 架构下可能不同):
```bash
ls ~/.local/share/opencode/sessions/ 2>/dev/null | wc -l   # 仅作可能路径参考
```
若残留堆积 → `session.delete` 未生效,见故障排查。

> 触发事件说明:plugin 默认只监听 `session.status` 的 idle(源码 status.ts 会**同时**发 `session.status` 和 `session.idle` 两个事件,两个都听 = fire-and-forget 并发下必双触发/死循环)。若你的 opencode 版本不发 `session.status`,把 `CONFIG.triggerEvent` 改成 `"session.idle"`。**绝不要同时监听两个**。

### 步骤 6:子 session 不受干扰验证
让 opencode 用 task 工具开子任务(比如"用子 agent 重构这个文件")。日志里子 session 的 idle 应出现:
```
[adv-review] skip child session: <childSid> parent= <parentSid>
```
说明子 agent 不会被误注入审阅。

---

## 三、观察项(DS review 收敛后仅剩这 2 个,源码已定的无需实测)

### 观察项 1:`session.create` 缺省 directory
代码里 `reviewDirectory` 默认 `undefined`(不传 `query.directory`)。**实测确认**:建出的冷 session 的 `session.directory` 是否 = 当前项目目录。
- 影响:若是,则冷 session 会加载当前项目 AGENTS.md(审阅者被轻微预热)。
- 怎么看:步骤 4 的日志里 `cold session created` 后,临时加一行打印 `created.data` 的 directory 字段比对。

### 观察项 2:追加的 system 能否压住 AGENTS.md
`prompt` 的 `system` 是**追加**在 AGENTS.md 之后(源码已确认,非覆盖)。审阅者人设排最后,通常靠位置权重压制。**实测确认**:看步骤 4 产出的审阅是否真的有对抗性、有没有顺着 AGENTS.md 的设定附和。
- 压得住 → 当前方案够用。
- 压不住 / 想彻底冷 → 启用实验选项 `reviewDirectory`(见下)。

### 实验选项:reviewDirectory(默认关闭)
`CONFIG.reviewDirectory` 设为项目外路径(如 `/tmp`),意图让冷 session 不加载当前项目 AGENTS.md。
> ⚠ **跨目录建 session 再 prompt 的路由行为未在源码完全钉死**。建议:先保持 `undefined` 跑通主流程,再单独试这个选项;若实测发现 session 仍跑在原目录或行为异常,就保持关闭,首版不用它。

---

## 四、配置说明

编辑 `~/.config/opencode/plugins/adversarial-review.js` 顶部的 `CONFIG` 对象:

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。`false` 完全禁用(无需删文件) |
| `triggerEvent` | `"session.status"` | 触发事件,二选一。idle 转变会**同时**发两个事件,**只能监听一个**否则死循环。默认 status(非 deprecated);版本不发 status 时改 `"session.idle"` |
| `reviewModel` | `undefined` | 审阅用模型。`undefined`=跟随默认;设 `{providerID, modelID}` 用更强模型 |
| `reviewDirectory` | `undefined` | **实验选项**,见观察项 2。默认关闭 |
| `reviewSystemPrompt` | 对抗性审阅者人设 | 作为 `prompt` 的 `system` 追加。可按需强化 |
| `reviewTimeoutMs` | `300000` (5分钟) | 审阅 prompt 超时,超时则 abort 审阅 session,避免 inFlight 永久残留 |

改完重启 opencode 生效。

**静音日志**:`ADV_DEBUG=0 opencode` 启动可关掉 console 输出(`client.app.log` 仍进日志体系)。

---

## 五、故障排查

### plugin 没加载(日志无 "plugin loaded")
- 确认文件在 `~/.config/opencode/plugins/adversarial-review.js`(注意是 `~/.config` 不是 `~/.opencode`)
- 确认是 `.js` 不是 `.ts`(省编译);若是 `.ts` 需 opencode 支持 TS 编译
- 确认 default export:`export default async function ...`(不是具名导出)
- 启动 opencode 时加 verbose 看加载错误

### 日志报 `Cannot find module '@opencode-ai/sdk'`
plugin 依赖 opencode 运行时注入的 `client`,不直接 import SDK。若报这个错,是 export 方式被 opencode 当成了普通模块——确认是 `export default async function({client})`。

### 报 `client.session.prompt is not a function` / 类型对不上
**版本漂移**:你的 opencode 版本的 SDK 可能与本 plugin 核对的不同。
```bash
# 查你服务器上实际的 SDK 版本和类型
find ~/.cache/opencode ~/.config/opencode -path '*@opencode-ai/sdk*/dist/client.d.ts' 2>/dev/null
# 看 SessionPromptData / session.create / session.messages 的实际签名
```
重点核对:`session.prompt` 的 body 是否接受 `{parts:[{type:"text",text}], system, tools}`、返回是否是 `{data:{info,parts}}`。若 `client.session.prompt` 调用风格不同(比如返回 unwrap 方式),按实际类型调整 `reviewResp.data?.parts` 的取值路径。

### 循环(步骤 5 失败:审阅续写不停)
立即设 `enabled:false`。可能原因:
- **同时监听了两个事件**:opencode 一次 idle 转变会同时 publish `session.status`(idle) 和 `session.idle`(源码 status.ts)。plugin 靠 `CONFIG.triggerEvent` 只听一个。**绝不要改成两个都听**——fire-and-forget 并发下两个 handler 都跑,`inFlight` 也挡不住(它在 await 之后才有机会生效),必双触发/死循环。
- **triggerEvent 选错**:默认 `session.status`,若你的版本不发这个事件 → 改 `session.idle`(二选一,看日志里 `plugin loaded; trigger=` 后实际触发的那个)。
- **parentID 比对失效**:防循环靠"续写回合 user 消息 id === 注入记录的 parentID"。检查日志里 `review injected into <sid> (... parentID=<msgID>)` 的 parentID,与续写回合拉到的最后一条 user 消息 id 是否一致;若你的版本 `session.prompt` 返回的 `info` 没有 parentID,需改用源码确认的等价字段。
- 自建 session 没被挡:确认日志里 `selfCreated` 的 sessionID 没重复触发审阅。

### 审阅质量差(顺着结论附和、不够对抗)
观察项 2 的表现。先强化 `reviewSystemPrompt`(加"必须给出至少 3 条反驳"之类硬约束);仍不行再试 `reviewDirectory:"/tmp"`。

---

## 六、降级方案:同步 → 异步(若同步 prompt 意外阻塞)

当前用同步 `session.prompt`(直接返回审阅结果,逻辑线性)。源码已确认 event hook 是 fire-and-forget、同步 prompt 不死锁。**但若你的版本出现主界面卡顿**,降级为事件驱动:

1. 冷审阅改用 `client.session.promptAsync`(`{path:{id}, body:{...}}`,返回 void)
2. 把 `reviewSessionID` 暂存到 inFlight 标记里
3. 在 `event` hook 里捕获该 review session 的 `session.idle`(此时审阅已完成),用 `client.session.messages` 拉审阅结果,再注入原 session

这把"一次同步等待"拆成"发起 + 回调",不阻塞 event handler。架构更复杂,仅作同步版出问题时的备选。**首版不要用**,先用同步版。

---

## 七、与 Claude Code 版的差异(参考)

| 维度 | Claude Code 版 | 本 opencode 版 |
|---|---|---|
| 语言 | bash | JS(opencode bun 运行时) |
| 触发 | Stop hook + stdin `last_assistant_message` | event hook + `session.idle` + `session.messages` 拉 |
| 冷 agent | `claude --bare -p`(外部进程) | 新 session + 同步 `session.prompt`(原生) |
| 注入 | `additionalContext` JSON | `session.prompt` 发消息 |
| 防循环 | `stop_hook_active`(原生字段) | 只听一个 idle 事件 + inFlight 前置 + justInjected(Map)按 parentID 比对 + session.error 清理 |
| 分类 | 两层(本地 + haiku) | 单层(本地),省一次 session 调用 |
| 部署 | 项目 `.claude/` | 全局 `~/.config/opencode/plugins/` |

---

## 八、核对清单(交付时记录)

**源码已定(三轮 review 核实):**
- [x] 按 2026-08 opencode dev 分支生成类型核对(服务器以实际版本为准)
- [x] `tools:{"*":false}` 禁用工具(非 `tools:{}`,后者是 no-op)
- [x] `system` 追加语义(非覆盖,排 AGENTS.md 之后)
- [x] event fire-and-forget:全局 try/catch + inFlight 前置(第一个 await 前)防并发双触发
- [x] **只监听一个 idle 事件**(`triggerEvent`,默认 session.status);idle 转变会同时发两个,两个都听必死循环
- [x] 只审主 session(`session.get` 查 parentID;fork 不带 parentID 仍被审)
- [x] 防循环靠 parentID 比对(justInjected=Map,存注入触发 assistant 的 parentID;续写回合 user 消息 id 匹配则跳过)
- [x] `session.status` 不传 path(端点 path=never,返回全量 map,按 sid 取)
- [x] `client.app.log` 补 service+level+message 必填 + `.catch` 吞 rejection
- [x] L1 过滤:短消息无结论词也跳过(挡住"你好/谢谢");有结论词放行保持 recall
- [x] 审阅超时(5min)+ abort,防 inFlight 永久残留
- [x] 注入成功后才记 justInjected(失败自然不残留)

**服务器实测后回填:**
- [ ] 步骤 1-6 全通过(重点:步骤 5 防循环只续写一轮 + 无 adv-review-cold 残留)
- [ ] 观察项 1:`session.create` 缺省 directory 是否 = 当前项目目录
- [ ] 观察项 2:追加的 system 能否压住 AGENTS.md(审阅够不够对抗)
- [ ] 你的 opencode 版本下 `triggerEvent` 选 status 还是 idle(看日志实际触发的)

---

## 九、已知边界(v1 接受,不阻塞部署)

1. **注入 prompt 无超时**:`reviewTimeoutMs` 只覆盖冷审阅 prompt,不覆盖"注入回原 session 后等 agent 回应审阅"这段时间。若该回合 agent 卡住(等权限确认/模型挂起),`inFlight` 会长驻直到该 session 下一个 idle。**v1 可接受**:会话本来就在忙,期间不存在可被漏审的 idle,不会造成循环,只是标记停留较久。
2. **compaction 场景的 parentID 误判**:若审阅续写回合期间触发了上下文压缩(compaction),会插入新 ID 的合成消息,导致续写回合的"最后一条 user 消息 id"不再等于记录的 parentID → 标记被清 → 可能把续写当新结论多审一次。**后果仅单次多余审阅,不形成循环**(下一轮注入会重新建立标记)。低频场景,v1 不修。
3. **`triggerEvent` 二选一的版本依赖**:默认 `session.status`,若你的 opencode 版本不发该事件需改 `session.idle`。两者不可同开(见故障排查"循环")。
