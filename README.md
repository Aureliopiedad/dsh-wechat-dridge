# WeChat ↔ DSH Bridge

仿照本地 `qq-bridge-main` 的 DSH 接入方式实现的 Windows 个人微信桥。复用 QQ bridge 的 DSH 客户端（Cookie 鉴权、斜杠 RPC、remote.mux），微信侧使用一个 Python/wxauto4 进程统一操作窗口。

```text
微信 → Python UI worker → Node 持久化 inbox → DSH session/prompt
                                              │
微信 ← Python UI worker ← 本机控制接口 ← MCP ← DSH 工具调用
```

## 已实现

- 按配置轮询指定私聊和群聊；每个聊天映射独立 DSH 会话，映射持久化。
- 首次启动只建立当前可见消息基线，随后捕获文本消息；先持久化后提交 DSH。
- DSH 不可用时保留消息，恢复后使用相同 requestId 重试。
- MCP：`wechat_send_message`、`wechat_send_file`、`wechat_get_recent_messages`、`wechat_status`。
- 发消息带 request_id 去重；发送与监听共用一个微信 worker。
- 默认 `tools` 模式由 DSH 调用工具发言；可选 `auto` 自动转发回合最终文本。
- DSH 提问转发与文本回答；工具审批默认拒绝，可单独为 owner 私聊启用。
- DSH 事件流断线重连，以及已持久化游标之后的快照回放。

这是核心收发版，未移植 QQ 项目的 Web 控制台、人格管理、仿真群友状态机、费用统计、贴纸、语音、联网搜索和 QQ 特有操作。

## 环境与安装

- Windows 10/11，微信桌面端已登录，桌面保持可交互。
- Node.js 22.13+；Python 3.12。
- 微信自动化依赖固定为 `wxauto4==41.1.2`。这是参考项目使用过的组合，不代表已在你的微信版本实测。
- DSH 适用协议与提供的 QQ bridge 一致；不使用旧微信插件的点号 RPC。

在项目目录运行：

```powershell
npm install --ignore-scripts
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r python\requirements.txt
Copy-Item config.example.json config.json
```

将 `config.json` 的 `python` 改为：

```json
{"command": ".venv/Scripts/python.exe", "args": []}
```

配置聊天，例如只接入一个你自己的控制私聊：

```json
{"name":"你的精确备注名","kind":"private","enabled":true,"allowSelf":false}
```

群聊示例（以界面显示昵称匹配，不是 wxid 鉴权）：

```json
{"name":"测试群","kind":"group","enabled":true,"senders":["你的群昵称"],"mentionOnly":true,"aliases":["机器人群昵称"]}
```

示例文件中的文件传输助手默认未启用。如启用并设置 `allowSelf:true`，可从手机发消息自测；自身消息回声过滤采用近期发送文本匹配，手机恰好发出相同内容可能被过滤，正式使用优先采用独立控制私聊。

`dsh.agentPreset` 默认 `standard`，意味着这些聊天能驱动该 preset 的工具。只启用你信任的聊天；群聊需要使用你自己安装、限制好工具的 preset。这个项目没有创建安全聊天 preset，也不会声称名单能替代 DSH 工具权限限制。

## 配置 MCP 到 DSH

```powershell
npm run setup:dsh
```

脚本生成 `dsh-mcp.patch.yml` 与通用 `mcp.config.json`，路径指向当前项目位置。
将前者的 `insert` 项合并进 DSH web profile 的 `cordis.patch.yml`，然后重启 DSH。**保留现有 QQ 条目**；不要用生成文件覆盖整个 profile。脚本本身不修改 DSH 文件或 QQ 配置。

若把整个项目移到其他目录，需要重新运行此脚本生成路径。

启动 bridge：

```powershell
npm start
```

先启动 bridge，等启用聊天完成首次基线读取后，再从手机发一条新的测试消息。首次建立基线前已存在的消息不会提交 DSH。配置修改后重启 bridge。

DSH 收到消息时会获得目标聊天名和 sessionId，并被提示通过 MCP 发言：

```json
{
  "to_user": "你的精确备注名",
  "message": "收到，任务完成。",
  "request_id": "reply-唯一标识-1",
  "session_id": "消息提示中的 DSH sessionId"
}
```

同一次发送重试时保留 request_id；发送不同消息使用新标识。发送文件使用 `wechat_send_file`，参数为 `to_user`、`file`（本地路径）、`request_id`、`session_id`。

`tools` 模式下模型只输出最终文本不会发微信，这是预期行为。需要自动转发则把 `replyMode` 改为 `auto`。自动模式下，若本回合已经通过带 session_id 的发送工具成功发出消息，会跳过最终文本转发。

## 提问与审批

提问会发送到当前聊天，后续文本作为答案；选项精确匹配 label，否则作为自定义答案。多问题时同一条回答用于每个问题，暂未实现逐题交互。

默认拒绝工具审批。需要远程审批时设置 `allowApprovals:true`，并给唯一可信私聊添加 `owner:true`。该私聊回复「通过」或「拒绝」。群聊不能审批。等待超时会拒绝审批或提交空问题答案。

## 状态与可靠性边界

- `state/bridge.json`：会话映射、inbox、outbox、观察基线、事件游标、未完成回合和挂起问题。不要在运行时手改。
- `state/mcp-token`：本机 MCP 到 bridge 的控制凭据。控制接口只绑定 127.0.0.1。状态文件包含聊天内容，不要提交或分享。
- 发送状态 `submitted` 只表示微信 UI 库确认操作成功，**不是服务端送达确认**。
- 发送超时或进程在发送中退出会保留 `uncertain` 状态，不自动重发。检查微信实际结果后，确需重发再使用新 request_id。
- 入站重试使用固定 DSH requestId；是否跨服务重启去重取决于 DSH 服务端。不能承诺端到端 exactly-once。
- UI 轮询只能读到当前可见消息。大量突发消息、切窗、客户端升级、控件 hash 变化都可能导致漏读或重复；连续相同文本的身份识别属于启发式实现。
- 重连快照只含有限事件，长时间断线超过快照范围可能无法恢复完整回复。
- 入站目前只处理文本；图片、语音、附件识别未接入。出站支持文本和本地文件。
- 读消息会切换窗口并标记已读；请不要同时运行其他 wxauto/MCP 微信自动化进程。不要关闭、手动干扰微信窗口或锁定桌面。
- inbox/outbox 当前保留完整历史用于幂等，不自动清理；长期使用前应补归档策略。

## 验证

```powershell
npm test
```

沙箱禁止测试子进程时可用：`node --test --test-isolation=none tests/*.test.mjs`（Node 24）。

测试覆盖持久化投递、故障重试、发送去重、目标绑定、工具/自动回复模式、群策略、快照恢复、MCP SDK 握手与调用、DSH RPC 格式。使用模拟微信和模拟 DSH，不会向真实聊天发送消息。

## 来源

`src/dsh-client.js` 复用 QQ bridge 的 MIT 代码，新增显式 `ws` 导入以支持 Cookie 请求头；上游完整许可及说明保存在 `LICENSE.qq-bridge`。其余代码为本次新增实现。没有复制或打包微信客户端与 wxauto4，依赖本身的使用条件以其发布说明为准。
