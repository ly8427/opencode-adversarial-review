# adversarial-review — opencode 冷 agent 对抗性审阅 plugin

当 [opencode](https://opencode.ai) 会话产出"重要结论"(架构决策、上线计划、技术选型、根因结论)时,自动起一个**新 session**(无历史 = 冷)做对抗性审阅,把反驳意见注入回原 session,逼原 agent 当场回应。

- **opencode 原生**:冷审阅用 `session.create` + `session.prompt`,不依赖任何外部 CLI
- **零 root 部署**:放进 `~/.config/opencode/plugins/` 即自动加载
- **防循环**:只监听一个 idle 事件 + inFlight 前置 + parentID 比对,事件并发/乱序下都不死循环
- **成本可控**:Layer 1 本地关键词过滤砍掉大部分噪音(闲聊/状态/纯代码),只对疑似结论调一次 LLM

## 快速开始

```bash
mkdir -p ~/.config/opencode/plugins
cp adversarial-review.js ~/.config/opencode/plugins/
```

重启 opencode 即生效。详细部署、配置、验证见 **[README-DEPLOY.md](./README-DEPLOY.md)**。

## 工作机制

```
session.idle (一轮回复结束)
  │
  ├─ 防循环: 只听一个事件 / inFlight 前置 / parentID 比对
  ├─ 只审主 session (parentID 为空;fork 的仍被审)
  ├─ 拉 last assistant 文本 → Layer 1 本地过滤(零成本)
  ├─ status 检查 (busy 则跳过)
  │
  ├─ 建冷 session (无历史) → 同步 prompt 审阅 (tools 全禁、system 注入对抗性人设)
  └─ 把审阅注入回原 session → 原 agent 续写回应
```

## 文件

| 文件 | 说明 |
|---|---|
| [`adversarial-review.js`](./adversarial-review.js) | plugin 本体 |
| [`README-DEPLOY.md`](./README-DEPLOY.md) | 部署 / 配置 / 6 步验证 / 故障排查 / 已知边界 |

## 配置(编辑 plugin 顶部 CONFIG)

| 字段 | 默认 | 说明 |
|---|---|---|
| `triggerEvent` | `"session.status"` | 触发事件二选一(idle 转变会同时发两个,只能听一个) |
| `reviewModel` | `undefined` | 审阅用模型;undefined 跟随默认 |
| `reviewDirectory` | `undefined` | 实验选项,指向项目外路径让审阅更冷 |
| `reviewTimeoutMs` | `300000` | 审阅超时,超时 abort 审阅 session |

## License

MIT
