# 开发与发布指南

本文命令均从仓库根目录执行，示例 shell 为 PowerShell 7。

## 1. 准备环境

安装：

- Node.js 22
- pnpm 9.15.4
- Rust stable 与 `x86_64-pc-windows-msvc`
- Python 3.12
- uv
- Visual Studio 2022 Build Tools：Desktop development with C++ 和 Windows 10/11 SDK
- Microsoft Edge WebView2 Runtime

```powershell
corepack enable
corepack prepare pnpm@9.15.4 --activate
rustup toolchain install stable
rustup target add x86_64-pc-windows-msvc
pnpm install --frozen-lockfile

Push-Location services/module-parser
uv sync --locked --extra dev --python 3.12
Pop-Location
```

## 2. 本地开发

启动 Worker 本地运行时：

```powershell
pnpm dev:relay
```

它默认监听 `http://127.0.0.1:8787`。另开终端启动纯前端预览：

```powershell
pnpm dev:desktop
```

纯前端预览用内存仓库和模拟解析，不能验证 SQLite、凭据管理、系统文件对话框或真实 sidecar。`dev:desktop` 会先构建共享协议，再同时监视协议和 UI。验证完整桌面路径：

```powershell
pnpm dev:tauri
```

`prepare:windows` 会构建共享协议，调用 `scripts/build.ps1` 以锁定依赖执行 PyInstaller 单文件构建，并将带 Tauri target triple 的 sidecar 放到正确位置。可执行文件是构建产物，不应提交。

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

真实解析可在 Tauri 的设置页保存 Key 后操作。本地生成一个可导入草稿时，也可使用开发辅助脚本；它会在终端中无回显读取 Key，Key 不进入命令行、环境变量、输出文件或缓存：

```powershell
Push-Location services/module-parser
uv run python scripts/parse_file.py C:\path\to\module.docx `
  ..\..\local-modules\module.cocmod.json `
  --cache-dir ..\..\local-modules\.cache
Pop-Location
```

辅助脚本只写入通过完整 Schema 校验的 `ModulePackageV1`。底层 JSONL sidecar 会产生零到多条 `progress`，最后恰好一条 `result` 或 `error`。真实调用会产生 API 费用；先用 `--mock` 验证输入。缓存不保存凭据，但会以未加密 JSON 保存已校验的分块抽取结果，因此应把它视为房主私密模组数据；可在应用退出后删除系统应用缓存中的 `module-parser` 目录来清空。

## 5. 检查与测试

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
- Python 默认测试使用模拟响应，不访问 DeepSeek。
- GitHub 的真实 DeepSeek 冒烟工作流只能通过 `workflow_dispatch` 手工执行，并要求 `DEEPSEEK_API_KEY` Secret；普通 push/PR CI 不读取该 Secret。

普通 `pnpm test` 中的 `RoomSession.live.test.ts` 默认跳过，因为它需要一个已启动的 Worker。CI 会启动本地 `workerd` 并设置 `COC_ROOM_LIVE_RELAY_URL`，让两个真实 `RoomSession` 通过 WebSocket 强制中继，验证聊天、骰子、模组切换、大型 UTF-8 揭示、离线事件和重连补发；这两个会话仍使用内存仓库，不是 SQLite 桌面 E2E。

Windows job 还会为每种模式分别启动两个独立的发布构建桌面进程（各自使用真实 WebView2），通过临时 rendezvous 文件交换房间凭据。基础传输冒烟分别验证浏览器 `RTCPeerConnection` / DataChannel 直连和本地 Worker 强制中继，并逐字校验大型中文与 emoji 载荷；完整会话冒烟则让两端各自使用独立 SQLite，验证房主排序、系统安全随机骰、重复命令幂等、离线事件、重连补发和最终事件日志一致。存储模式另行验证 SQLite 重读、Markdown/无脚本自包含 HTML 文件导出、打包后的 mock Python sidecar，以及测试房间清理。NSIS 阶段会静默安装后再次执行存储、导出和 sidecar 检查，再验证卸载。

## 6. Windows x64 NSIS 构建

一键准备带 target triple 的 sidecar、构建协议和 Tauri：

```powershell
$env:VITE_RELAY_URL = "https://your-worker.your-subdomain.workers.dev"
pnpm build:windows
```

NSIS 安装包输出到 `apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`；不同 Tauri/Cargo 环境也可能省略 target triple 这一层，可在 `apps/desktop/src-tauri/target/release/bundle/nsis/` 查找。首版没有商业代码签名，Windows SmartScreen 可能提示未知发布者。

CI 的 Windows job 会优先使用手工运行时的 `relay_url` 输入，其次使用仓库变量 `PUBLIC_RELAY_URL`，都未设置时才回退到 `http://127.0.0.1:8787`。它会构建 NSIS，在临时目录静默安装，精确启动桌面主程序后卸载。发布前应设置生产 HTTPS origin，并先运行 `pnpm --filter @coc-room/relay smoke https://...` 验收节点。
