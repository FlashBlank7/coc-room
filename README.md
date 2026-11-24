# CoC Room

CoC Room is a virtual tabletop for Call of Cthulhu. To try it without a model API key, follow the [local two-browser walkthrough](#快速开始本机双端体验): host a session, invite a player, roll dice, and export the play log.

面向《克苏鲁的呼唤》7 版的联机跑团工具：KP（守秘人）创建房间、邀请玩家、逐步公开情境与线索，玩家在同一现场发言、使用角色卡并完成检定。调查记录保存在各自本机，结束后可导出为 Markdown 或离线网页。

项目采用本地优先、房主中心式 P2P 架构，提供 Windows Tauri 桌面端和用于开发体验的浏览器入口。房主排序房间事件，参与者优先通过 WebRTC DataChannel 直连，失败时退回 Cloudflare Worker WebSocket 中继。模组整理、地图和 AI 辅助按需使用，手动开团不要求模型账号或 API Key。

> 当前状态：早期开发版。协议、数据库和模组 Schema 仍可能在 `0.x` 期间调整。仓库默认指向本机 Worker，本 README 不提供可直接使用的公共节点；请启动本地 Worker，或自行部署一份。

| 你想做什么 | 从哪里开始 |
| --- | --- |
| 先看看开团和玩家加入流程 | [本机双端体验](#快速开始本机双端体验)，只需 Node.js 与 pnpm |
| 开发界面、房间逻辑或协议 | [日常开发](#日常开发与可选能力)，浏览器热更新 |
| 使用 SQLite、系统文件框或打包 Windows 应用 | [桌面原生功能](#桌面原生功能)，另需 Rust 与 Windows 构建工具 |
| 邀请另一台设备上的朋友 | [公网联机](#公网联机)，先部署自己的信令/中继节点 |
| 了解数据流、权限和部署方式 | [架构说明](docs/architecture.md)、[开发指南](docs/development.md) |

## 已实现的核心能力

- 2–8 人 V2 房间，无账号；每位玩家使用独立 `seatId + seatSecret` 邀请并通过房主 HMAC 挑战认证
- 房主权威连续事件序列、完整/脱敏视图、幂等落库、最多 500 条或 4 MiB 的逐页 ACK 补发
- 文字聊天、CoC 7 版角色卡、普通骰式、`d100` 奖惩骰与成功等级
- 玩家先描述行动、KP 再裁定是否检定；失败后可提出一次强推，KP 必须先声明二次失败代价
- 本机 SQLite 记录、离线记录查看，导出 Markdown 或无脚本离线 HTML；网页记录会嵌入本席位可见且在安全大小内的本机图片/音频，缺失或过大的媒体明确标注原因；无权席位只落不含类型、正文和资源哈希的连续占位头
- 模组资料库与 `ModulePackageV1`，可按场景、地点、NPC、线索、手记、检定和关系浏览，并用结构化表单修正常用字段；解析结果先审阅再保存/启用
- V2 独立实体、Artifact、NPC 互动和通用 `scene` / `map` / `evidence` 画板；自由摆放、关系线与合作式多边形迷雾
- SHA-256 内容寻址资源库；图片规范化、音频资源、本地同步播放，以及 24 KiB 分块的 P2P/WSS 续传与复核
- 个人角色库与安全 ZIP `.cocchar`；新模组使用带 manifest、画板和资源的安全 ZIP `.cocmod`
- Python/LangGraph sidecar 默认委托本机已登录的 Codex CLI 做 Schema 约束抽取；DeepSeek API 作为显式可选提供者
- 粘贴文本及 `.txt`、`.md`、`.docx`、数字/扫描/混合 PDF 输入；ZIP 中的多份文档会自动合并解析；扫描页视觉转写走 Codex `--image`
- 独立 Codex App Server 图片执行器；地点、NPC、角色、封面和无文字地图均先生成本机草稿，人工确认后才绑定发布
- NPC 自动互动读取当前 NPC 卡、KP 挂载资料和本面板最近消息；支持 KP 审核后发布或直接自动发布，可随时停止
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
                 Python JSONL sidecar ─┬─ 本机 Codex CLI ── OpenAI
                                       └─ DeepSeek API（手动回退）
```

房主与每位玩家形成星形连接，不建立玩家间全连接。Worker 的 Durable Object 不创建应用数据表或 KV 记录；房间 ID、角色和令牌关系由凭据无状态验证，在线成员状态只存在于可休眠的 WebSocket attachment 中。聊天、事件、信令正文和中继正文均不持久化。更完整的数据流和边界见 [架构说明](docs/architecture.md)。

## 环境要求

- Windows 10/11 x64
- 日常网页开发只需要 Node.js 22 与 pnpm 9.15.4（建议通过 Corepack 使用）
- 验证桌面原生功能时再安装 Rust stable、`x86_64-pc-windows-msvc`、Visual Studio 2022 Build Tools、Windows SDK 与 WebView2 Runtime
- 构建模组解析 sidecar 时再安装 Python 3.12 与 [uv](https://docs.astral.sh/uv/)
- 真实 Codex 解析还需要已安装并登录的 Codex CLI（`codex login`）

## 快速开始：本机双端体验

以下命令从全新 clone 开始，示例使用 PowerShell。先安装 Node.js 22（仓库 `.node-version` 为 22.23.2）和 pnpm 9.15.4；如使用 Corepack，可用 `corepack pnpm` 替代下方的 `pnpm`。已有多个 Node 版本时，先确认当前终端选中了 22.x，双端启动器会拒绝旧版本。

```powershell
git clone https://github.com/FlashBlank7/coc-room.git
cd coc-room
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm --filter @coc-room/protocol build
pnpm --filter @coc-room/desktop build
pnpm dev:web:duo
```

**首次启动前的两次构建不能省略。** 协议包提供类型入口；当前 Worker 配置同时托管 `apps/desktop/dist`，没有这个目录时，本地中继会报 `assets.directory ... does not exist` 并退出。构建完成后，日常前端开发仍使用热更新，无需每次重建。

启动器会打开 KP `http://127.0.0.1:1420` 和玩家 `http://127.0.0.1:1421`，并启动 `http://127.0.0.1:8787` 的本地信令/中继与协议监视。两个网页使用不同 Origin，各自有独立的 IndexedDB，适合在一台电脑上模拟两名参与者。启动器不会调用模型，按 Ctrl+C 会统一关闭子进程。

1. 在 KP 页选择“我是 KP，开一个新团”，填写称呼、房间名，点击“创建房间并进入”。
2. 在现场填写“第一位玩家称呼”，点击“生成专属邀请”，复制整段邀请。每位玩家使用自己的邀请。
3. 在玩家页选择“我是玩家，加入朋友”，填写称呼并粘贴邀请，点击“加入调查”。
4. 两边在“现场发言”中各发送一条消息，确认对方收到。需要试骰时展开“自由掷骰”，点击“掷骰并记录”。
5. 房间右上角“…”菜单可以导出文字/网页记录；“返回开始页”后，可从房间卡片选择“只看记录”。

这条路径不需要导入模组、准备地图、安装 Python/Rust 或登录 AI 服务。网页数据保存在该浏览器和 Origin 下，清理网站数据会删除本机记录，请及时导出。

本地中继邀请包含回环地址，**只能用于同一台电脑**。另一台设备不能通过这份邀请连接你的 `127.0.0.1`；跨设备使用请看[公网联机](#公网联机)。本机双端运行也不等于公网或跨网络验证。

端口占用时可指定三个不同的空闲端口：

```powershell
pnpm dev:web:duo --no-open --kp-port 19240 --player-port 19241 --relay-port 19242
```

此时手动打开 `http://127.0.0.1:19240` 与 `http://127.0.0.1:19241`。想只检查服务能否启停，可在完成首次构建后运行 `pnpm smoke:web-duo`；它不操作浏览器，也不验证完整开团流程。

## 日常开发与可选能力

### 浏览器热更新

默认开发入口会同时启动本地信令/中继、共享协议监视和 Vite 网页，并自动打开 `http://127.0.0.1:1420`：

```powershell
pnpm dev
```

页面和协议源码修改会热更新，不会编译 Rust、Python sidecar 或 NSIS。如果 `8787` 端口已有中继在运行，只启动网页与协议监视：

```powershell
pnpm dev:web:ui
```

`pnpm dev:desktop` 保留为 `dev:web:ui` 的兼容别名。网页右下角会标明运行模式；房间、模组、角色与设置保存在浏览器 IndexedDB。只有 Rust/Tauri 配置、桌面内嵌 Python sidecar 或正式 NSIS 发布需要原生重编译或重启。详见[开发与发布指南](docs/development.md#2-本地开发)。

### AI 辅助与文档解析（可选）

真实 Codex/DeepSeek 模组解析、AI 车卡、NPC 属性草稿、受限上下文 NPC 回复，以及 TXT/Markdown/DOCX/PDF/安全 ZIP 输入都可通过 Vite 同源本地安全桥运行，无需重编译 Tauri；长解析可从界面安全停止，迟到结果不会写入草稿。先准备 Python 3.12 和 uv，在仓库根目录执行：

```powershell
Push-Location services/module-parser
uv sync --locked --extra dev --python 3.12
Pop-Location
```

Codex 路径需要本机已安装并登录的 Codex CLI，使用该账号额度；DeepSeek 是显式可选提供者，需要自己的 API Key 并产生 API 费用。DeepSeek Key 使用隐藏终端输入写入 Windows Credential Manager：

```powershell
pnpm ai:key:set
pnpm ai:key:status
```

本地桥不接受来自网页的 Key、本机路径、命令、Shell、工具或自定义提供者地址。长任务有宽松的兜底超时（总 12 小时、15 分钟无心跳）；网页刷新、取消或断开会终止 Python/Codex 整个进程树。上传文件只在校验后的系统临时目录中存活到任务结束或取消清理完成。

双端启动器默认只在 KP 页启用本地 AI 安全桥；玩家页没有桥令牌或桥路由，房间内角色草稿会通过房间消息交给 KP。URL 中的联调角色参数只显示标签，不用于授权。

### 桌面原生功能

按上面的环境要求安装 Rust、Windows 构建工具、WebView2，以及 Python 3.12/uv 后，首次运行：

```powershell
pnpm dev:tauri:first # 首次准备 sidecar 并启动
```

完成首次准备后，日常桌面壳验收直接运行 `pnpm dev:tauri`，不会重复构建 sidecar。进程保持运行时，React、TypeScript 与 CSS 修改也会热更新，不会重打安装包；只有 Rust、Tauri 配置或 Python sidecar 本体变化需要重新运行 `pnpm prepare:windows` 或等待对应的原生重编译/重启。

网页壳层冒烟测试不需要 Rust 或 Python：

```powershell
pnpm smoke:web
```

准备好 Python 解析环境后，`pnpm smoke:web-bridge` 会在临时端口验证 Vite、HMR、安全桥会话边界和离线 mock 解析，且不会启动或编译 Tauri。

## 公网联机

本地默认中继源为 `http://127.0.0.1:8787`。部署 Worker 后，将 `VITE_RELAY_URL` 设为 Wrangler 输出的 HTTPS **源地址**（不是房间 WebSocket 完整 URL），再启动或构建客户端：

```powershell
$env:VITE_RELAY_URL = "https://your-worker.your-subdomain.workers.dev"
pnpm dev:tauri
```

应用内“设置”保存的中继地址会成为后续运行时配置。完整开发、测试、Worker 自部署、sidecar 和 NSIS 打包命令见 [开发指南](docs/development.md)。

仓库不提供公共节点地址。公网使用时，先按开发指南部署自己的 Worker，并用仓库自带的 relay smoke 验收 HTTPS 源地址；房主随后在“设置 → 公网信令/中继节点”中填入该源地址并保存。创建房间后，完整的 WSS 房间地址会写进邀请串，玩家直接粘贴邀请串即可加入，不需要另外配置该 Worker。

## 模组备团与发布

导入 `.cocmod.json` 后，模组会自动滚动到右侧“检查整理结果”，并以“阅读备团资料”模式打开；概览会直接列出人物和地点名称，点击名称可进入完整资料卡。“检查并修正”用于修正元数据、章节、场景、地点、NPC、线索、手记、检定和主持人笔记，“高级数据 → 编辑底层 JSON”保留完整底层编辑能力。Codex/DeepSeek 会为地点与 NPC 尝试生成保守、无剧透的玩家可见初见稿；无法安全判断时留空，且所有稿件都必须由 KP 审核。已经保存在资料库中的模组可点击左侧卡片的“打开”；浏览器预览持久化到 IndexedDB，Tauri 桌面版持久化到 SQLite。

新的 `.cocmod` ZIP 可以保留预设画板与资源描述符，但导入模组不等于把它们发布进当前房间：模组库会持续显示这项提醒，KP 仍需在现场明确检查、绑定和公开。网页端导出会先把 JSON 与资源字节复制到当前 JavaScript realm，避免嵌入式 WebView/测试环境把字节数组误编码成 ZIP 目录；导出的 `.cocmod` 与 `.cocchar` 都必须通过再导入回归测试。

## V2 沉浸式房间

模组实体与房间实体、Artifact、画板位置彼此独立。KP 从本机模组的精确修订发布玩家可见快照后，可以把同一个 NPC 放到多个画板、把已公开线索连接成线索板，或让 NPC 完全不出现在地点上。公开画板不能引用定向秘密内容，协议 reducer 会拒绝这类泄漏，而不是只靠界面隐藏。

背景图和音频事件只保存内容描述符；实际字节进入应用数据目录中的内容寻址资源库。玩家只有先收到带该描述符的完整授权事件，房主才会响应资源请求。慢速下载不阻塞事件游标，哈希失败则拒绝入库；已发布音频会自动预取，KP 只在当前在线受众席位确认资源就绪后创建播放事件。

V1 房间仍可从本机打开和导出，但只读且不会原地升级。V2 的席位、定向事件、画板、资源和 NPC 会话不会写进 V1 记录。协议详见 [V2 架构与路线图](docs/v2-architecture.md)，后续地图分期见 [进阶地图路线图](docs/advanced-map-roadmap.md)。

## 隐私与安全边界

- WebRTC DataChannel 使用 DTLS 加密；WSS 能保护客户端到 Worker 的传输。
- 首版**没有应用层端到端加密**。连接退回 WebSocket 中继时，Cloudflare 和 Worker 运营者理论上能够读取转发中的正文，请勿通过不受信任的公共节点传输敏感内容。
- Worker 不建立聊天历史或模组正文存储，也不持久化房间元数据或令牌摘要。随机房主令牌通过带域分隔的 SHA-256 派生玩家加入令牌和房间 ID，使 Durable Object 能在不查询服务端房间记录的情况下验证房间、角色和预留的房主 peer ID；未认证 socket 的 15 秒截止 alarm 与在线 WebSocket attachment 不构成可恢复的房间历史。
- 聊天、角色变化、骰子和已揭示内容保存在每个参与者本机：桌面端使用 SQLite，网页开发模式使用 IndexedDB。完整模组只应保存在房主本地。
- V2 角色卡默认全房间可见；私人笔记只存在个人角色库和 `.cocchar`，不会进入房间事件。已经发出的内容无法撤回，扩大受众会发送新的授权视图。
- V2 地点、NPC、线索、画板和 NPC 会话都带受众；无权席位只收到脱敏占位。迷雾是协作 UI 遮罩，不是密码学保密。
- Codex 路径只启动本机已登录的 `codex exec`，不会读取、复制或转发 Codex 登录令牌，也不会开放通用 Codex/HTTP 代理。网页开发时使用的同源本地安全桥仅提供固定任务路由。模组正文仍会经 Codex 发送到 OpenAI；这不是离线推理。
- 模组文本与 NPC 文本任务使用固定 Schema、临时工作目录并关闭工具。PDF 视觉页由已授权原文件重新渲染、复核后通过 `codex exec --image` 进入独立严格转写步骤，临时图随后销毁。NPC 请求边界没有房间快照、数据库、文件路径、网络工具或通用 Codex 指令字段；Codex 图片使用另一条 App Server 执行器，返回路径必须位于执行器拥有的目录并经图片验证与资源入库。
- DeepSeek API Key 仅在用户明确选择 DeepSeek 时由 Tauri 从 Windows Credential Manager 读取，并通过 sidecar 的 stdin JSONL 传递；不要把 Key 写入仓库、`.env`、命令行参数、日志或 GitHub Actions 文件。
- 发送给 Codex 或 DeepSeek 的模组原文会离开本机，并受对应服务条款与数据政策约束。离线模拟解析不会联网。
- 模组导入会拒绝 ZIP 路径穿越、符号链接、加密包、异常压缩比，以及带宏、ActiveX、嵌入对象或 DTD 的 DOCX；含多份文档的 ZIP 会按文件名顺序合并解析。这不是完整的恶意文件沙箱。

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

## 仓库内容

本仓库保留应用源码、测试、文档和原创测试样例。本机导入的模组压缩包、解析导出文件、聊天记录、运行数据库与凭据不随仓库上传；使用真实模组的手动验证需自行提供输入文件。
