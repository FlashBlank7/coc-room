# 开发与发布指南

本文命令均从仓库根目录执行，示例 shell 为 PowerShell 7。

## 1. 准备环境

网页 UI、房间网络和 Worker 的日常开发只需安装：

- Node.js 22
- pnpm 9.15.4

仓库根目录的 `.node-version` 固定为已验证的 Node 22 版本。若机器上同时装有多个 Node，请先确认 `node --version` 为 22.x；双端网页启动器也会在旧版本上提前停止并给出明确提示，避免把运行时不兼容误判成业务 Bug。

网页中运行真实 Codex/DeepSeek 模组解析时，额外需要：

- Python 3.12 与 uv（用于现有 JSONL 解析器）
- Codex 路径：已安装并执行过 `codex login`
- DeepSeek 路径：可选，只从 Windows Credential Manager 读取 Key

只有验证或打包 Tauri 桌面能力时才需要：

- Rust stable 与 `x86_64-pc-windows-msvc`
- Python 3.12
- uv
- Visual Studio 2022 Build Tools：Desktop development with C++ 和 Windows 10/11 SDK
- Microsoft Edge WebView2 Runtime
- 可选：真实 Codex 解析需要 Codex CLI，并先执行 `codex login`

```powershell
corepack enable
corepack prepare pnpm@9.15.4 --activate
pnpm install --frozen-lockfile
```

需要桌面端时再补充：

```powershell
rustup toolchain install stable
rustup target add x86_64-pc-windows-msvc

Push-Location services/module-parser
uv sync --locked --extra dev --python 3.12
Pop-Location
```

## 2. 本地开发

先看结论：修界面和房间逻辑不需要反复编译、安装桌面包。开发时保持一个进程运行，保存文件后由 Vite 把变化直接送进浏览器或正在打开的 Tauri WebView。

| 正在修改的内容 | 使用入口 | 保存后的反馈 | 是否重新构建 sidecar / NSIS |
| --- | --- | --- | --- |
| React、TypeScript、CSS、共享协议、房间逻辑 | `pnpm dev` | 浏览器热更新；改动边界允许时保留组件状态 | 否 |
| 网页安全桥或 Python 解析器源码 | 保持 `pnpm dev`；Vite 必要时自动重启，或手动重启该进程 | 页面重载或下一次解析任务读取新代码 | 否 |
| 同样的前端改动，但需要顺便验证 SQLite、原生文件框或桌面资源库 | 首次 `pnpm dev:tauri:first`，以后保持 `pnpm dev:tauri` 运行 | Tauri 窗口内热更新 | 否 |
| Rust 命令或 Rust 依赖 | `pnpm dev:tauri` | Cargo 增量编译并重启原生进程 | 不构建 NSIS |
| Python 解析器源码 | 网页路径直接用 `pnpm dev`；桌面内嵌版本才重新运行 `pnpm prepare:windows` | 网页桥重启后读取源码；桌面版更新 sidecar 后重启 | 仅桌面内嵌版本需要 |
| 安装包、签名和发布配置 | `pnpm build:windows` | 生成 NSIS 安装包 | 是，只在发布验收时 |

换句话说，当前大量 UI/交互 Bug 应在网页模式里连续修；只有接近阶段验收时才打开桌面壳检查原生边界。真实 Codex/DeepSeek、DOCX 和 PDF 解析也能从网页开发页调用本地安全桥，所以不需要为了获得热更新而把登录令牌或 API Key 交给网页 JavaScript。

默认采用 web-first 工作流。一条命令会先构建共享协议，然后并行启动协议监视、Vite 和 Wrangler 本地中继，并自动打开浏览器：

```powershell
pnpm dev
```

网页监听 `http://127.0.0.1:1420`，中继监听 `http://127.0.0.1:8787`。React、样式以及共享协议源码改动会进入 Vite 热更新，不会触发 Rust、sidecar 或安装包编译。

中继已经在其他终端运行时，可以只启动网页和共享协议监视：

```powershell
pnpm dev:web:ui
```

`pnpm dev:desktop` 是 `dev:web:ui` 的兼容别名。若 1420 被占用，可给独立网页进程设置其他端口，例如：

```powershell
$env:COC_ROOM_WEB_PORT = "1421"
pnpm dev:web:ui
```

双端联调可用一个跨平台命令同时启动协议监视、本地中继、KP 页面和玩家页面：

```powershell
pnpm dev:web:duo
```

默认 KP 为 `http://127.0.0.1:1420`，玩家为 `http://127.0.0.1:1421`，两端共用 `http://127.0.0.1:8787` 中继。端口属于浏览器 Origin 的一部分，因此两个页面各自使用独立 IndexedDB；这比在同一 Origin 开两个标签更接近真实 KP/玩家的数据隔离。只有 KP Vite 进程注册本地 AI 安全桥，玩家页不注入桥令牌也不提供桥路由；玩家在房间内申请角色草稿时仍通过房间消息交给 KP 执行。这个边界由启动时的进程环境决定，URL 中的 `duoRole` 只用于显示联调标签，不参与授权。启动器不用 shell 专属的环境变量语法，按一次 Ctrl+C 会清理两个 Vite、Wrangler/workerd 和协议监视进程。它只启动开发能力，不会自动调用 Codex、DeepSeek 或 Python 解析器。

端口被占用时可运行 `pnpm dev:web:duo --help` 查看跨平台参数；不打开浏览器可追加 `--no-open`。仓库的轻量 smoke 会自动选择三个临时端口，只读取两个开发页并检查本地中继，不执行 AI 请求：

```powershell
pnpm smoke:web-duo
```

纯网页模式会在右下角显示能力提示，并在 React 渲染失败时提供可恢复的错误页面。它把房间、模组、角色与设置持久化到浏览器 IndexedDB，并提供显式清空入口。单端 `pnpm dev` 与双端联调的 KP 页可以把 TXT/Markdown、DOCX、PDF 和安全 ZIP 从网页文件选择器交给本地桥，再调用与桌面端相同的 Python JSONL 解析器；双端联调的玩家页不具备这项本机能力。React、解析 UI 和桥接代码改动都不需要重新编译 Tauri。

本地桥是 Vite 开发服务器的同源中间件，只绑定既有的 `127.0.0.1` 开发页。它只公开状态、模组解析、PDF 页预览、角色草稿、NPC 属性草稿和受限上下文 NPC 回复六条固定路由；这不是可配置的 Codex 代理。每条路由都要求精确 Origin、Host、same-origin Fetch Metadata，以及每次 Vite 启动时随机生成的 256-bit 开发会话令牌。令牌只注入当前开发页的 HTML 并通过自定义请求头返回，不进入 URL、Cookie、IndexedDB、localStorage、生产构建或日志；重启 Vite 后旧页面的令牌立即失效。不接受浏览器提供的 action、本机路径、API Key、提供者地址、命令、Shell、工具、可执行文件或超时配置。上传文件先校验长度和 SHA-256，只写入系统临时目录；响应禁用缓存。

真实解析采用桥内固定的 45 分钟总任务上限和 60 秒无合法 JSONL 空闲上限。Codex 工作流每 15 秒发出的、能够解析且 `request_id` 匹配的进度心跳会重置空闲计时，但不会延长总上限；乱码、截断 JSON 或错误任务 ID 不算活动。Codex JSONL 的通用 `error` 事件不会被猜测为某一种网络故障；它只作为不含正文的安全状态上报。单次报错后 45 秒没有新 CLI 事件，或 CLI 持续重复报错 120 秒仍未恢复到正常 turn/item 进度时，子进程会以 `CODEX_CLI_STALLED` 回收，避免让 KP 等到总超时；明确的 `turn.failed` 始终优先于超时和退出码分类。角色/NPC 三条短任务使用固定 120 秒总上限、256 KiB 输出上限和唯一终态校验，不接受浏览器调整。浏览器点击“停止整理”、取消请求、关闭/刷新页面或连接异常断开时，桥会终止整个 Python/Codex 子进程树，等待终止完成后再清理该任务的临时文件；取消后的迟到响应不能写入草稿或资料库。上述时限和取消行为不能由网页请求覆盖。桥不会在生产构建中启用。真实解析若一个有效分块都没有生成，只返回错误，不允许空壳模组进入资料库；有部分有效内容时才进入 `needs_review` 人工复核。

网页仍不能验证 SQLite、原生系统文件对话框或桌面托管资源库。相关功能达到阶段验收点时再运行完整桌面路径：

```powershell
pnpm dev:tauri:first # 首次准备 sidecar 并启动
```

`prepare:windows` 会构建共享协议，调用 `scripts/build.ps1` 以锁定依赖执行 PyInstaller 单文件构建，并将带 Tauri target triple 的 sidecar 放到正确位置。可执行文件是构建产物，不应提交。

`pnpm dev:tauri:first` 负责首次准备；之后日常桌面壳验收直接运行 `pnpm dev:tauri`，不会重复执行 PyInstaller。进程保持运行时，React、TypeScript 和 CSS 修复仍由 Vite 热更新，不会重打 NSIS。修改 Rust 命令、Cargo/Tauri 配置或 Python sidecar 本体时才需要重新运行 `pnpm prepare:windows` 或等待对应的原生重编译/重启。日常界面、协议与房间逻辑调试仍优先使用 `pnpm dev`。

不安装 Rust/Python 也可以快速验证网页运行模式提示和错误边界：

```powershell
pnpm smoke:web
```

已经准备 Python 解析环境后，可用一条 smoke 命令实际启动一个临时端口上的 Vite 与安全桥，并依次验证开发会话令牌、同源拒绝、HMR WebSocket、桥状态和离线 mock 结构化解析；脚本最后会关闭 Vite，并确认桥随同一进程停止。它不会启动 Tauri、Rust、真实 Codex/DeepSeek 调用或浏览器窗口：

```powershell
pnpm smoke:web-bridge
```

## 3. Worker 自部署

当前仓库不提供已上线的公共 Worker。使用自己的 Cloudflare 账户登录并部署：

```powershell
pnpm --filter @coc-room/relay exec wrangler login
pnpm --filter @coc-room/relay check
pnpm --filter @coc-room/relay test
pnpm --filter @coc-room/relay deploy
```

如默认名称已被占用，先修改 `apps/relay/wrangler.jsonc` 中的 `name`。保留 `v1` Durable Object migration；已经部署后若要改类名，应新增 rename migration，不要改写历史 tag。

部署完成后，先用实际 HTTPS origin 验收建房、认证、分片和中继：

```powershell
pnpm --filter @coc-room/relay smoke -- https://your-worker.your-subdomain.workers.dev
```

将同一个 HTTPS origin 配成前端初始值：

```powershell
$env:VITE_RELAY_URL = "https://your-worker.your-subdomain.workers.dev"
pnpm dev:tauri
```

`VITE_RELAY_URL` 必须是可接受 `POST /v1/rooms` 的 HTTP(S) 源地址，不是某个房间的 `/v1/rooms/<id>/ws` 地址。生产 HTTPS origin 会由建房接口生成相应的 `wss://` 房间地址。应用内设置可覆盖构建时默认值。

已经安装的桌面版不必重新构建：房主可在“设置 → 公网信令/中继节点”中填写该 HTTPS origin 并保存。创建房间后，应用会把建房接口返回的完整 WSS 地址放入邀请串；玩家粘贴邀请串即可使用同一节点，无需单独填写 Worker 地址。

在开放公共节点前，建议在 Cloudflare 侧为建房和 WebSocket 路径配置速率限制。Worker 限制一个房主加七名玩家，单个 UTF-8 JSON 帧最多 65,536 字节；桌面端会自动把超限的应用层中继消息切成带校验的分片并在接收端重组。

## 4. 模组解析器

运行测试和离线 mock：

```powershell
Push-Location services/module-parser
uv run pytest
'{"id":"demo","source_text":"# 雾中车站`n## 月台`n线索：一张旧车票","source_name":"demo.md","mock":true}' | uv run python -m coc_module_parser
Pop-Location
```

桌面端默认使用本机 Codex CLI。先登录，再在“设置 → AI 文字服务”检测状态：

```powershell
codex login
codex login status
```

网页开发模式也复用同一份 Codex CLI 登录，不复制登录令牌。先准备解析器环境，然后保持 `pnpm dev` 运行即可在模组库中直接选择 DOCX/PDF/ZIP 或粘贴文本并真实解析：

```powershell
Push-Location services/module-parser
uv sync --locked --extra dev --python 3.12
Pop-Location
pnpm dev
```

DeepSeek Key 不经过网页 JavaScript、IndexedDB、localStorage、URL、命令行参数或日志。请用隐藏输入将轮换后的 Key 写入与 Tauri 共用的 Windows Credential Manager 条目：

```powershell
pnpm ai:key:set
pnpm ai:key:status
# 不再使用时：pnpm ai:key:delete
```

此前在聊天、终端历史或其他明文位置出现过的 Key 视为已经暴露，必须先去 DeepSeek 控制台轮换；不要把旧 Key 再写入凭据管理器。网页只查询“是否存在”这一布尔状态，实际 Key 由一次性 Python 包装进程在内存中读取并通过 stdin 边界注入解析任务。

本地生成一个可导入草稿时，也可使用开发辅助脚本。Codex 登录完全由 CLI 管理，应用不会读取登录令牌；正文经 stdin 传给一次性 `codex exec` 任务：

```powershell
Push-Location services/module-parser
uv run python scripts/parse_file.py C:\path\to\module.docx `
  ..\..\local-modules\module.cocmod.json `
  --provider codex `
  --cache-dir ..\..\local-modules\.cache
Pop-Location
```

如需手动回退到 DeepSeek，追加 `--provider deepseek --model deepseek-v4-flash`；脚本会在终端中无回显读取 Key，Key 不进入命令行、环境变量、输出文件或缓存。

辅助脚本只写入通过完整 Schema 校验的 `ModulePackageV1`。底层 JSONL sidecar 会产生零到多条 `progress`，最后恰好一条 `result` 或 `error`。Codex 会使用 ChatGPT/Codex 账户额度，DeepSeek 会产生 API 费用；先用 `--mock` 验证输入。缓存不保存凭据，但会以未加密 JSON 保存已校验的分块抽取结果，因此应把它视为房主私密模组数据；可在应用退出后删除系统应用缓存中的 `module-parser` 目录来清空。

若输入是“一个 PDF 加若干静态图片”的安全 ZIP，正文抽取与网页里的 PDF 选页预览会复用同一套归档校验；预览不会绕过校验去打开任意 ZIP 成员。解析失败时辅助脚本只报告稳定错误码且不写模组文件，不把原文、提供者私有报错或 Python traceback 当成诊断信息打印。ZIP 内的图片目前只返回去路径的安全元数据，仍需 KP 在房间中明确选择、预览并绑定；界面不会声称它们已经成为背景图。

## 5. V2 沉浸式房间边界

开发房间世界功能时必须保持以下边界：

- V1 房间只允许查看和导出，不能原地升级；新的席位、受众、画板、资源和 NPC 会话只进入 V2。
- KP 控制面板只能加载 `module.switched` 指定的本机精确修订，不能自动用同一模组的最新修订代替。解析草稿、正式模组和已在房间启用的版本是三个不同状态。
- 地点、NPC、场景和线索发布只能从 KP 明确选择的玩家可见字段构造最小快照，绝不能回退到守秘人描述，也不能附带动机、数值、关系、主持人笔记和原文定位。
- 所有持久操作都先成为房主确认的 `RoomEventV2`，再由 `deriveRoomWorldStateV2` 投影。玩家提交命令时不能直接修改权威世界；地图拖拽可以先显示本地预览，但确认失败或超时必须回退并说明原因。
- 定向内容使用 `AudienceV2`。无权席位只能收到不含事件类型、正文和资源哈希的脱敏占位头；只在 React 中隐藏正文不构成保密。测试必须同时检查玩家世界投影、SQLite/IndexedDB、日志和导出。
- 图片和音频只在事件中保存 `AssetDescriptorV1`。实际字节进入 SHA-256 内容寻址资源库，并在席位先获得引用事件后才允许通过资源 DataChannel 或 WSS 回退请求。禁止把 Base64 或二进制正文塞进房间事件。
- 场景画板、地图画板和线索板彼此独立。NPC 与地点不建立所有权关系，同一 NPC 可以有多个表现棋子；把线索放到画板不会改变线索实体的受众或归属。
- 角色草稿、模组解析草稿和 AI 生成结果都必须停留在本地审核态；只有显式保存、启用或发布后才能形成正式记录。网页刷新恢复点不能自动发布，也不能跨房间或席位复用。
- NPC 自动互动只能读取 NPC 卡、KP 显式挂载的最多 12 条资料，以及当前面板最近 40 条且最多 24,000 字符的消息；请求中不得出现房间快照、完整模组、文件路径、数据库或工具入口。

协议与桌面测试应覆盖精确修订、全局连续序号、受众脱敏、重连补发、角色所有权、资源授权、地图乐观提交回退、模组/角色草稿恢复，以及公开快照中不含 KP 私密字段。完整旅程测试还应验证地点与 NPC 发布、一次真实房主骰点、KP 叙述交接、多人拾取同一线索和单一公共线索板项目。

## 6. 检查与测试

```powershell
pnpm --filter @coc-room/protocol build
pnpm check
pnpm test
pnpm build

Push-Location services/module-parser
uv run pytest
Pop-Location
```

- TypeScript 测试覆盖共享协议、排序/去重/补发、骰子、导出、仓库与 Worker 协议。
- 桌面端通过 workspace 包的 `dist` 类型入口解析共享协议，因此全新 checkout 要先执行上面的协议构建。
- Worker 测试运行在 Cloudflare 的本地 `workerd` 环境，不访问已部署服务。
- Python 默认测试使用模拟响应或伪造子进程，不调用 Codex 或 DeepSeek。
- 真实 Codex 调用依赖当前 Windows 用户自己的 CLI 登录并消耗其 Codex 额度，默认 CI 不运行。
- GitHub 的真实 DeepSeek 冒烟工作流只能通过 `workflow_dispatch` 手工执行，并要求 `DEEPSEEK_API_KEY` Secret；普通 push/PR CI 不读取该 Secret。

普通 `pnpm test` 中的 `RoomSession.live.test.ts` 和 `RoomSessionV2.live.test.ts` 默认跳过，因为它们需要一个已启动的 Worker。CI 会启动本地 `workerd` 并设置 `COC_ROOM_LIVE_RELAY_URL`：V1 验证聊天、骰子、模组切换、大型 UTF-8 揭示、离线事件和重连补发；V2 另外验证独立席位 HMAC 认证、定向秘密只落脱敏头、资源哈希不泄漏，以及同一席位换 peer 后补发。这些会话仍使用内存仓库，不是 SQLite 桌面 E2E。

Windows job 还会为每种模式分别启动两个独立的发布构建桌面进程（各自使用真实 WebView2），通过临时 rendezvous 文件交换房间凭据。基础传输冒烟分别验证浏览器 `RTCPeerConnection` / DataChannel 直连和本地 Worker 强制中继，并逐字校验大型中文与 emoji 载荷；完整会话冒烟则让两端各自使用独立 SQLite，验证房主排序、系统安全随机骰、重复命令幂等、离线事件、重连补发和最终事件日志一致。存储模式另行验证 SQLite 重读、Markdown/无脚本离线 HTML 文件导出、打包后的 mock Python sidecar，以及测试房间清理。V2 网页记录只从当前席位的完整事件视图收集资源：安全大小内的本机图片与音频会转为 `data:` 嵌入，缺失、校验失败或超过 16 MiB 单音频/32 MiB 总量上限的媒体会在记录中明确标注，脱敏占位永远不会触发资源读取。NSIS 阶段会静默安装后再次执行存储、导出和 sidecar 检查，再验证卸载。

## 7. Windows x64 NSIS 构建

一键准备带 target triple 的 sidecar、构建协议和 Tauri：

```powershell
$env:VITE_RELAY_URL = "https://your-worker.your-subdomain.workers.dev"
pnpm build:windows
```

NSIS 安装包输出到 `apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`；不同 Tauri/Cargo 环境也可能省略 target triple 这一层，可在 `apps/desktop/src-tauri/target/release/bundle/nsis/` 查找。首版没有商业代码签名，Windows SmartScreen 可能提示未知发布者。

CI 的 Windows job 会优先使用手工运行时的 `relay_url` 输入，其次使用仓库变量 `PUBLIC_RELAY_URL`，都未设置时才回退到 `http://127.0.0.1:8787`。它会构建 NSIS，在临时目录静默安装，精确启动桌面主程序后卸载。发布前应设置生产 HTTPS origin，并先运行 `pnpm --filter @coc-room/relay smoke https://...` 验收节点。
