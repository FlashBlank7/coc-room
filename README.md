# CoC Room

一个面向《克苏鲁的呼唤》7 版跑团的本地优先、房主中心式 P2P 桌面应用。项目以“能开团、记录可信、模组可整理”为目标：房主排序房间事件，参与者优先通过 WebRTC DataChannel 直连，失败时退回 Cloudflare Worker WebSocket 中继；各客户端只在本机保存自己收到的记录。

> 当前状态：早期开发版。协议、数据库和模组 Schema 仍可能在 `0.x` 期间调整。仓库没有已经部署好的公共 Worker；开发或使用前请启动本地 Worker，或自行部署一份。

## 已实现的核心能力

- 2–8 人房间，无账号，以房间 ID 和随机令牌加入
- 房主权威事件序列、事件幂等落库、断线后分块补发
- 文字聊天、CoC 7 版角色卡、普通骰式、`d100` 奖惩骰与成功等级
- 本机 SQLite 记录、离线记录查看，导出 Markdown 或自包含 HTML
- 模组资料库与 `ModulePackageV1`，可按场景、地点、NPC、线索、手记、检定和关系浏览；解析结果先审阅再保存/启用
- Python/LangGraph sidecar 调用 DeepSeek Responses API 做 JSON Schema 结构化抽取
- 粘贴文本及 `.txt`、`.md`、`.docx`、安全单文档 `.zip` 输入
- Cloudflare Durable Objects 信令与临时中继，可自行部署

## 架构概览

```text
                           Cloudflare Worker / Durable Object
                         （建房、在线状态、信令、临时中继）
                                      │
                        ┌─────────────┴─────────────┐
                        │ WebSocket                 │ WebSocket
                        │                           │
                 房主 Tauri 客户端 ═ WebRTC ═ 玩家 Tauri 客户端
                        │    DataChannel            │
                        │                           │
                 SQLite + Credential Manager       SQLite
                        │
                 Python JSONL sidecar ── DeepSeek API
```

房主与每位玩家形成星形连接，不建立玩家间全连接。Worker 的 Durable Object 不创建应用数据表或 KV 记录；房间 ID、角色和令牌关系由凭据无状态验证，在线成员状态只存在于可休眠的 WebSocket attachment 中。聊天、事件、信令正文和中继正文均不持久化。更完整的数据流和边界见 [架构说明](docs/architecture.md)。

## 环境要求

- Windows 10/11 x64
- Node.js 22、pnpm 9.15.4（建议通过 Corepack 使用）
- Rust stable，目标 `x86_64-pc-windows-msvc`
- Python 3.12 与 [uv](https://docs.astral.sh/uv/)
- Visual Studio 2022 Build Tools（Desktop development with C++、Windows SDK）
- Microsoft Edge WebView2 Runtime

## 快速开始

安装 JavaScript 依赖：

```powershell
corepack enable
corepack prepare pnpm@9.15.4 --activate
pnpm install --frozen-lockfile
```

终端一启动本地信令/中继节点：

```powershell
pnpm dev:relay
```

终端二启动浏览器预览：

```powershell
pnpm dev:desktop
```

根命令会先构建共享协议，再同时监视协议和桌面 UI，因此干净 checkout 不会读到过期 `dist`。浏览器预览使用内存仓库，只适合 UI 开发；SQLite、Windows Credential Manager 和真实 Python sidecar 需要 Tauri。启动完整桌面应用：

```powershell
pnpm dev:tauri
```

本地默认中继源为 `http://127.0.0.1:8787`。部署 Worker 后，将 `VITE_RELAY_URL` 设为 Wrangler 输出的 HTTPS **源地址**（不是房间 WebSocket 完整 URL），再启动或构建客户端：

```powershell
$env:VITE_RELAY_URL = "https://your-worker.your-subdomain.workers.dev"
pnpm dev:tauri
```

应用内“设置”保存的中继地址会成为后续运行时配置。完整开发、测试、Worker 自部署、sidecar 和 NSIS 打包命令见 [开发指南](docs/development.md)。

当前项目没有公共 Worker。公网使用时，先按开发指南部署自己的 Worker，并用仓库自带的 relay smoke 验收 HTTPS 源地址；房主随后在“设置 → 公网信令/中继节点”中填入该源地址并保存。创建房间后，完整的 WSS 房间地址会写进邀请串，玩家直接粘贴邀请串即可加入，不需要另外配置该 Worker。

导入 `.cocmod.json` 后，模组会自动在右侧“模组工作台”的“资料浏览”模式打开。已经保存在资料库中的模组可点击左侧卡片的“打开”，再从分类栏进入“地点”或“NPC”；浏览器预览刷新后会清空内存数据，Tauri 桌面版才会持久化到 SQLite。

## 隐私与安全边界

- WebRTC DataChannel 使用 DTLS 加密；WSS 能保护客户端到 Worker 的传输。
- 首版**没有应用层端到端加密**。连接退回 WebSocket 中继时，Cloudflare 和 Worker 运营者理论上能够读取转发中的正文，请勿通过不受信任的公共节点传输敏感内容。
- Worker 不建立聊天历史或模组正文存储，也不持久化房间元数据或令牌摘要。随机房主令牌通过带域分隔的 SHA-256 派生玩家加入令牌和房间 ID，使 Durable Object 能在不查询服务端房间记录的情况下验证房间、角色和预留的房主 peer ID；未认证 socket 的 15 秒截止 alarm 与在线 WebSocket attachment 不构成可恢复的房间历史。
- 聊天、角色变化、骰子和已揭示内容保存在每个参与者自己的 SQLite 中。完整模组只应保存在房主本地。
- DeepSeek API Key 由 Tauri 写入 Windows Credential Manager，只通过 sidecar 的 stdin JSONL 传递；不要把 Key 写入仓库、`.env`、命令行参数、日志或 GitHub Actions 文件。
- 发送给 DeepSeek 的模组原文会离开本机，并受 DeepSeek 服务条款与数据政策约束。离线模拟解析不会联网。
- 模组导入会拒绝 ZIP 路径穿越、符号链接、加密包、异常压缩比、多文档载荷，以及带宏、ActiveX、嵌入对象或 DTD 的 DOCX；这不是完整的恶意文件沙箱。

## 常用检查

```powershell
pnpm --filter @coc-room/protocol build
pnpm check
pnpm test
pnpm build

Push-Location services/module-parser
uv sync --locked --extra dev --python 3.12
uv run pytest
Pop-Location
```

真实 DeepSeek 冒烟测试不会在普通 CI 或 PR 中运行；只能手工触发 GitHub Actions 的 `DeepSeek live smoke test`，并由仓库 Secret `DEEPSEEK_API_KEY` 提供凭据。

## 项目布局

- `apps/desktop`：React/Vite/Tauri 桌面端
- `apps/relay`：Cloudflare Worker 与 Durable Object
- `packages/protocol`：共享协议、Schema、骰子、同步与导出
- `services/module-parser`：Python 3.12 模组解析 sidecar

## 许可证

[MIT](LICENSE)
