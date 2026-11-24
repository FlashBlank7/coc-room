# 公开版 README 与本机双端验证

日期：2026-11-24（Asia/Tokyo）。代码基线：公开 GitHub `FlashBlank7/coc-room` 的 `f589d44a4c3be8556b8b3d421b832f51a30d806e`，独立 shallow clone。此次只修改文档，产品能力与验收结论以该公开版本为准。

## 目的与证据

让首次访问者能判断项目用途，并从全新 clone 走通不依赖 AI 的最小开团路径；高级模组、权限、安全、原生构建等说明继续保留。

直接读取的公开来源包括根目录和 desktop/relay 的 `package.json`、`scripts/dev-web-duo.mjs`、`apps/desktop/vite.config.ts`、`apps/relay/wrangler.jsonc`、`LobbyView.tsx`、`RoomViewV2.tsx` 与 `docs/development.md`。

首次运行发现：`pnpm install --frozen-lockfile` 后直接运行双端启动器，中继因 `assets.directory` 指向不存在的 `apps/desktop/dist` 退出。构建共享协议与 desktop 前端后，使用相同启动器与端口恢复成功。因此在根 README、英文 relay README 与开发指南中补齐首次准备步骤；没有修改运行代码。

## 实际验证

环境：Windows、Node.js 22.23.2、pnpm 9.15.4、Edge 无头浏览器，1440 × 1000。默认终端曾解析到 Node 18，后续运行均显式使用 Node 22，未修改全局配置。TEMP/TMP/TMPDIR 和 npm/pnpm 缓存显式放在 F 盘。

1. 安装锁文件依赖；共享协议构建成功；`pnpm --filter @coc-room/desktop build` 成功。Vite 有既存的混合静态/动态导入提示，构建退出码为 0。
2. 执行 `node scripts/dev-web-duo.mjs --no-open --kp-port 19240 --player-port 19241 --relay-port 19242`，启动 KP、玩家、协议监视与本地 Worker。
3. 在真实浏览器的 19240 页面点击 KP 建房，填写称呼与房间名；生成一位玩家的独立邀请。
4. 在 19241 页面填写玩家称呼、粘贴邀请并“加入调查”；两端各发一条中文消息并在对方页面确认逐字显示。两页未观察到 `pageerror`。
5. KP 展开“自由掷骰”，实际点击“掷骰并记录”；随后下载 Markdown 和 HTML 导出文件。Markdown 包含双方聊天及 `1d100` 骰子事件。
6. KP 通过菜单返回开始页，选择“只看记录”，确认玩家消息仍可读。
7. `pnpm smoke:web` 通过，1 个文件、4 个测试。此自动检查仅覆盖网页壳层，不能替代上面的浏览器流程。

本机证据位于被 Git 忽略的 `.tmp/`：浏览器脚本 `.tmp/browser/probe.cjs`、页面截图、界面文字和导出文件。页面包含测试邀请，证据文件不随公开文档提交。

## 适用范围与未检查项

已验证的是一台 Windows 电脑、两个不同 Origin 的浏览器页面，以及本地 Worker。未独立强制区分 WebRTC 与 WebSocket 路径；聊天成功不能证明特定传输路径成功。未检查跨设备、跨网络、公网部署、安装包、SQLite、媒体同步或真实 Codex/DeepSeek 调用。HTML 已下载，未把此次检查扩写为完整离线媒体或全格式验收。

复用经验：全新 clone 的启动说明必须按依赖顺序实际执行；Worker 托管静态资源时，开发启动器也可能依赖一次前端构建。不同 Origin 可隔离浏览器数据库，回环邀请不能用来邀请另一台设备。
