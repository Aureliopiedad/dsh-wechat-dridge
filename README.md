# WeChat ↔ DSH Bridge

Windows 微信桥：C# UI Automation worker → Node 持久化 inbox → DSH。MCP 接口与 DSH 会话、重试、出站幂等机制保留。

## 启动

需要 Windows 10/11、Node.js 22.13+、已登录微信及系统 .NET Framework 4.x。无需 Python、wxauto、NuGet 或 .NET SDK。

```powershell
npm install --ignore-scripts
npm run build:worker
# 仅首次配置时复制，不要覆盖已有 config.json
Copy-Item config.example.json config.json
npm start
```

启动前手动将配置中每个启用私聊打开成独立窗口，标题须与 chats.name 精确一致。默认每 3 秒补查末尾最多 80 个消息控件，无消息不输出扫描日志。读取不切窗、不截图；不依赖窗口位置。最小化时继续轮询，但微信是否更新最小化窗口的 UIA 树必须实测；如果恢复窗口后才收到内容，说明该版本无法用此方式实时后台监听。

```json
{"worker":{"command":"native/Worker.exe","args":[]},"wechat":{"pollIntervalMs":3000,"baselineOnFirstStart":true}}
```

## 消息和发送者

C# 后端不识别发送者，sender 为 unknown、senderKnown 为 false。私聊中自己和对方的文本均可能进入 DSH，allowSelf 无法据此区分；带【AI回复】换行前缀的入站文本统一过滤，防止本桥回声循环，也会过滤用户主动发送的同前缀消息。

群聊依赖 senders 身份过滤，当前后端无法执行，配置启用群聊会明确报错。仅启用可信私聊。

首次读取或消息序列无法衔接时只建立基线，不转发历史。通过正文有序序列而非 runtime ID 衔接观察；重复正文、滚动、虚拟化、编辑、突发消息超出尾部范围仍可能造成漏读或重读，不能保证可靠存档。只接收文本（含引用文本），暂不解析图片、语音、附件或精确发送时间。

## 出站与 MCP

保留 wechat_send_message、wechat_send_file、wechat_get_recent_messages、wechat_status。所有出站文本添加【AI回复】标记；文件先发送 AI 说明。

C# 发送会恢复并激活目标独立窗口，覆盖系统剪贴板，粘贴后按 Enter；需要可交互桌面，请勿在发送期间操作键鼠。文件发送通过剪贴板文件列表和 Enter，特定微信版本的确认弹窗需要实测。submitted 仅表示 UI 输入已发出，不代表送达。失败记为 uncertain，不自动重发。已发说明后文件失败，同样视为不确定。

默认 tools 模式由 DSH 调 MCP 发言；auto 模式自动转发最终文本，已通过工具发送的回合不重复转发。session_id 必须与目标聊天映射一致；同一次重试保留 request_id。

```json
{"to_user":"目标窗口标题","message":"收到","request_id":"reply-unique-1","session_id":"对应 DSH sessionId"}
```

## DSH 配置及持久化

npm run setup:dsh 生成 dsh-mcp.patch.yml 和 mcp.config.json。将生成 patch 的 insert 合并进 DSH profile，保留已有 QQ 等条目，然后重启 DSH。脚本不直接修改 DSH profile。

state/bridge.json 保存会话、inbox、outbox、观察基线、事件游标及问题；state/mcp-token 为仅绑定 127.0.0.1 的控制接口凭据。不要分享状态或运行时手改。DSH 离线保留入站，固定 requestId 重试。工具审批默认拒绝，仅可信 owner 私聊可开启。状态历史未自动清理。

## 验证

npm test 使用模拟微信/DSH，覆盖投递、幂等、会话绑定、回声过滤和基线恢复等。native/Worker.cs 已在本机编译；自动测试不证明真实微信收发、文件弹窗或最小化兼容性。Python 目录保留作旧实现参考，默认启动不再使用。

DSH 客户端基于本地 QQ bridge 的 MIT 代码，来源许可见 LICENSE.qq-bridge。

可选顶层配置 modelLabel 可指定展示名称，例如 "modelLabel": "你的模型名"，出站前缀变为【AI回复｜你的模型名】。未配置时统一使用【AI回复】。该名称是人工配置标签，不代表已从 DSH 验证实际模型身份。C# 发送边界也强制补充 AI 标识。

## 唤醒词
顶层 wake 配置：{"enabled":true,"word":"小助手","historyCount":20}。普通消息只持久化到 messages，不投递 DSH；文本包含唤醒词（大小写敏感、子串匹配）时，按顺序打包最近 20 条已观察到的非 AI 文本，包含触发消息，作为一次 prompt。首次可读历史只缓存不触发。每条包含唤醒词的新消息各触发一次。上下文不跨聊天；不足条数就发送已有记录。等待 DSH 提问/审批时无需唤醒，下一条消息直接回答。关闭 enabled 恢复逐条投递。重启 bridge 生效；变更前已有 pending inbox 仍会按原规则处理。历史不代表完整微信聊天，仅为 bridge 已读取并保存的消息。

聊天配置可添加 sessionId 指向已有 DSH 会话；启动时优先覆盖该聊天的持久化映射，不再自动新建。多个聊天不能配置同一 sessionId。修改后重启；旧会话保留，不会删除。已有会话必须在当前 DSH 可访问。
