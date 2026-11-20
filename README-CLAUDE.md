# adversarial-review for Claude Code

把"重要结论的独立第二意见"带进 Claude Code：主会话给出结论后，由一个**无对话历史、无任何工具**的独立审阅进程（`claude --bare` 冷进程）提出有依据的异议，主 Agent 必须逐条**接受 / 反驳（给依据）/ 标注待验证**。

定位与 OpenCode 版一致：这是"重要结论的第二意见"工具，不是完整的多 Agent 代码审查系统。原 OpenCode 插件（`adversarial-review.js`）**本分支零改动**，两条入口互不影响。

---

## 工作机制

两条触发路径，默认只有第一条：

1. **手动命令**（默认可用）：`/adversarial-review` —— 主会话当前回合内同步跑一次冷审阅，结果作为工具返回值当场回到对话，主 Agent 逐条回应。**零错位风险、零意外等待**（是你自己发起的）。
2. **自动审阅**（默认关，配置开启）：收尾钩子（Stop Hook）在主 Agent 每轮说完话、准备结束的那一刻触发，同步跑审阅：
   - 回合在钩子运行期间**冻结**——审阅结果只能落回"产生这个回答的同一轮"，结构上不存在 OpenCode 异步旁听那种"结果迟到插进新对话"的错位问题；
   - 有实质发现 → 阻止收尾并把审阅意见喂回主 Agent（反馈**固定 1 轮**，由 `stop_hook_active` 硬闸保证，不依赖宿主的连续阻止熔断）；
   - 无实质发现 / 失败 / 超时 / 你按 Esc 打断 → 静默放行，**结果永不事后补注，也从不中止你的会话**；
   - 成本：自动模式下每轮符合粗筛条件的回答会多一段审阅等待（默认硬上限 120 秒）。

## 冷审阅者的隔离保证

审阅进程 = `claude --bare -p --tools "" --disallowedTools "*" --output-format json`（固定参数，配置不可覆盖）：

| 参数 | 效果 | 实机核对（claude 2.1.97, 2026-11-20） |
|---|---|---|
| `--bare` | 跳过 hooks / skills / plugins / MCP / 记忆 / CLAUDE.md 的发现加载 → **审阅进程不会加载本插件自身**（杜绝自我递归） | 生效 |
| `--tools ""` | 全部内置工具**移出模型上下文**（输入 token 4172 → 350，模型自答"无工具"） | 生效；注意 `--disallowedTools "*"` 单用**不移除上下文**，只拒绝调用 |
| `--disallowedTools "*"` | 硬 deny 兜底，防任何残余工具 | 与 `--tools ""` 双保险 |
| `--model <X>`（可选配置） | 审阅用不同/更强模型，与主会话解耦 | 可选 |

提示词经 **stdin** 传入（多行中文提示词不经 argv，绕开 shell 转义问题）。

---

## 安装

**前置**：node >= 18；Claude Code CLI 在 PATH 上。

### 方式 A：插件目录直载（推荐试用）

```bash
claude --plugin-dir /path/to/opencode-adversarial-review
```

插件根即本仓库根（`.claude-plugin/plugin.json` + `hooks/hooks.json` + `commands/`）。命令 `/adversarial-review` 立即可用；Stop 钩子已接线但默认 `mode: "manual"`，钩子毫秒级放行，零开销。

### 方式 B：手动接线（不使用插件机制）

1. 把本仓库 clone 到固定位置；
2. 在 `~/.claude/settings.json` 加入：

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node \"<仓库绝对路径>/src/hook-stop.mjs\"", "timeout": 180 } ] }
    ]
  }
}
```

3. 把 `commands/adversarial-review.md` 复制到 `~/.claude/commands/`，并把文件内的 `${CLAUDE_PLUGIN_ROOT}` 替换为仓库绝对路径。

### 卸载

方式 A：去掉 `--plugin-dir` 参数（或在插件管理里禁用）即可，无其他残留。方式 B：删掉 settings.json 里那一段和复制的命令文件。状态与历史都在 `~/.adv-review/`，删目录即彻底清除。

---

## 配置

优先级：项目 `.adversarial-review.json` > 全局 `~/.adv-review/config.json` > 内置默认。字段：

```json
{
  "enabled": true,
  "mode": "manual",              // manual=仅手动命令（默认）；auto=Stop 钩子自动审
  "reviewerCommand": "claude",   // 审阅命令
  "reviewerArgs": [],            // 追加参数（不能覆盖固定安全参数）
  "reviewModel": null,           // 审阅模型，如 "opus"；缺省=跟随 claude 默认
  "reviewTimeoutMs": 120000,     // 审阅硬超时；到点杀审阅进程、放行主会话。
                                 // 自动钩子路径实际上限 170 秒（低于钩子 180 秒预算，超出自动截断）；
                                 // CLI 路径（手动命令）不受此限
  "cooldownMs": 1800000,         // 同一回答内容的免审冷却（默认 30 分钟）
  "skipPattern": "\\[(skip|noreview|debug)\\]",   // 用户提词命中 → 该轮不审
  "reviewPattern": null,         // 设了则只审命中该正则的轮次（opt-in 白名单）
  "minAnswerLen": 60,            // 粗筛最短长度
  "includeGitEvidence": false    // 自动审时附带 git diff/status 摘要做证据
}
```

环境变量逃生门：`ADV_REVIEW_CONFIG`（指定配置文件）、`ADV_STATE_DIR`（状态目录）、`ADV_REVIEWER_CMD`（整体替换审阅命令，测试/包装器用）、`ADV_DEBUG_FILE`（调试日志落盘）。

**开启自动审**：项目根放 `.adversarial-review.json` 写 `{"mode": "auto"}`。

## 使用

```
/adversarial-review                     审当前回合的最终回答
/adversarial-review focus 重点看并发安全  指定攻击方向
/adversarial-review status              查看任务状态
/adversarial-review history             查看最近审阅记录
/adversarial-review config              查看生效配置与审阅命令探活
```

也可以直接用底层 CLI（给脚本/CI）：`node src/cli.mjs review|status|history|config-check`。

无发现时输出 `verdict=no_material_findings` 是**合法成功结果**，审阅者被明确允许"没找到实质问题就说没有"，不为凑数硬挑刺。

---

## 验证清单（区分"单测证明了什么"与"只有实机能证明什么"）

单测（`node --test`，70 项，零依赖、离线可跑）覆盖：粗筛各分支、哈希去重与内容变更重审、状态原子写与损坏恢复、冷却、结果规范化（含畸形输出）、钩子 stdin→stdout 全路径（假审阅器注入）、超时杀进程、失败不阻断。**它们不能证明真实宿主行为**，以下实机项按此清单验收：

| # | 实机验收项 | 状态 |
|---|---|---|
| 1 | 干净配置下 Claude Code 能发现并加载插件（命令 + 钩子出现） | 待实机 |
| 2 | 手动命令全链路：既能提出有效异议，也允许无问题通过 | **已实证 2 例**（cli 后端直连真实 claude 2.1.97：抓出 TOCTOU 竞态 1 例 / no_material_findings 1 例） |
| 3 | 审阅者无法使用任何工具 | **已实证**（`--tools ""` 模型自答无工具） |
| 4 | 自动模式：Stop 触发 → block 反馈 → 续写一轮后停止（`stop_hook_active`） | 待实机 |
| 5 | 修改回答内容后重新审阅，旧结果不冒充新版本（哈希绑定） | 单测已证；实机待验 |
| 6 | 超时/失败/重复触发/Esc 打断：不误报通过、不无限循环、不误取消用户新任务 | 单测已证（杀子进程、放行语义）；实机待验 |
| 7 | 卸载后不破坏用户原有配置 | 设计保证（钩子即全部接线），待实机 |
| 8 | OpenCode 原入口未被破坏 | **结构性保证**（本分支对 adversarial-review.js 零改动） |

已知边界：老版本 Claude Code 若无 `last_assistant_message` 字段，钩子退化读 transcript 最后一条 assistant 文本（解析有单测，字段差异待实机核对）；审阅结果绑定回答内容哈希，改动后重新审阅才是对新版本的意见。

## 欠账

见 [docs/DEBT.md](docs/DEBT.md)（OpenCode 三处小修、实机 E2E 清单、marketplace 打包等）。
