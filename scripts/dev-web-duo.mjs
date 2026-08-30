import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_PORTS = Object.freeze({ kp: 1420, player: 1421, relay: 8787 });
const STARTUP_TIMEOUT_MS = 25_000;
const MINIMUM_NODE_MAJOR = 22;

export function assertSupportedNodeVersion(version = process.versions.node) {
  const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
  if (!Number.isInteger(major) || major < MINIMUM_NODE_MAJOR) {
    const currentVersion = Number.isInteger(major) ? version : "未知版本";
    throw new Error(`需要 Node.js ${MINIMUM_NODE_MAJOR}+，当前为 ${currentVersion}；请先切换 Node 再启动网页开发环境`);
  }
}

export function parseDuoArguments(argv) {
  const options = {
    help: false,
    smoke: false,
    open: true,
    kpPort: DEFAULT_PORTS.kp,
    playerPort: DEFAULT_PORTS.player,
    relayPort: DEFAULT_PORTS.relay,
  };
  let customPort = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--smoke") {
      options.smoke = true;
      options.open = false;
      continue;
    }
    if (argument === "--no-open") {
      options.open = false;
      continue;
    }
    const [name, inlineValue] = argument.split("=", 2);
    if (name === "--kp-port" || name === "--player-port" || name === "--relay-port") {
      const rawValue = inlineValue ?? argv[++index];
      if (rawValue === undefined) throw new Error(`${name} requires a port number`);
      const port = parsePort(rawValue, name);
      if (name === "--kp-port") options.kpPort = port;
      if (name === "--player-port") options.playerPort = port;
      if (name === "--relay-port") options.relayPort = port;
      customPort = true;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }

  if (options.smoke && customPort) throw new Error("--smoke chooses isolated ports and cannot be combined with port options");
  assertDistinctPorts(options);
  return options;
}

export function createDuoProcessSpecs(workspaceRoot, options, nodeExecutable = process.execPath) {
  const protocolRoot = join(workspaceRoot, "packages", "protocol");
  const desktopRoot = join(workspaceRoot, "apps", "desktop");
  const relayRoot = join(workspaceRoot, "apps", "relay");
  const tscEntry = join(protocolRoot, "node_modules", "typescript", "bin", "tsc");
  const viteEntry = join(desktopRoot, "node_modules", "vite", "bin", "vite.js");
  const wranglerEntry = join(relayRoot, "node_modules", "wrangler", "bin", "wrangler.js");
  const relayOrigin = `http://127.0.0.1:${options.relayPort}`;

  const viteSpec = (label, port, role) => ({
    label,
    executable: nodeExecutable,
    args: [
      viteEntry,
      "--mode",
      "web",
      ...(options.open ? ["--open", `/?duoRole=${role}`] : []),
    ],
    cwd: desktopRoot,
    env: {
      COC_ROOM_WEB_PORT: String(port),
      COC_ROOM_LOCAL_AI_BRIDGE: role === "keeper" ? "enabled" : "disabled",
      VITE_RELAY_URL: relayOrigin,
    },
  });

  return {
    build: {
      label: "protocol-build",
      executable: nodeExecutable,
      args: [tscEntry, "-p", "tsconfig.build.json"],
      cwd: protocolRoot,
      env: {},
    },
    services: [
      {
        label: "protocol",
        executable: nodeExecutable,
        args: [tscEntry, "-p", "tsconfig.build.json", "--watch", "--preserveWatchOutput"],
        cwd: protocolRoot,
        env: {},
      },
      {
        label: "relay",
        executable: nodeExecutable,
        args: [wranglerEntry, "dev", "--ip", "127.0.0.1", "--port", String(options.relayPort)],
        cwd: relayRoot,
        env: {},
      },
      viteSpec("KP", options.kpPort, "keeper"),
      viteSpec("player", options.playerPort, "player"),
    ],
  };
}

export function duoHelpText() {
  return `CoC Room 双端网页联调

用法：
  pnpm dev:web:duo [选项]

默认同时启动：
  KP       http://127.0.0.1:1420
  玩家     http://127.0.0.1:1421
  中继     http://127.0.0.1:8787
  协议     TypeScript watch

两个网页属于不同 Origin，因此各自拥有独立 IndexedDB。只有 KP 页启用
本地 AI 安全桥；玩家的角色草稿请求经房间交给 KP。启动器本身不会调用模型。

选项：
  --no-open             启动服务但不自动打开浏览器
  --kp-port <port>      修改 KP 端口
  --player-port <port>  修改玩家端口
  --relay-port <port>   修改本地中继端口
  --smoke               使用随机空闲端口做无浏览器、无 AI 的启停检查
  -h, --help            显示帮助

按 Ctrl+C 会由启动器关闭 protocol、Wrangler/workerd 和两个 Vite 进程。`;
}

export async function runDuo(argv = process.argv.slice(2)) {
  assertSupportedNodeVersion();
  const parsed = parseDuoArguments(argv);
  if (parsed.help) {
    console.log(duoHelpText());
    return 0;
  }

  const options = parsed.smoke ? await withIsolatedPorts(parsed) : parsed;
  const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const specs = createDuoProcessSpecs(workspaceRoot, options);
  await assertPortsAvailable(options);

  console.log("[duo] 正在构建共享协议（不会编译 Tauri）…");
  const buildCode = await runOneShot(specs.build);
  if (buildCode !== 0) return buildCode;

  const supervisor = new ChildSupervisor();
  const disposeSignals = bindShutdownSignals(supervisor);
  try {
    for (const spec of specs.services) supervisor.start(spec);

    const readiness = verifyDuoReadiness(options);
    const earlyStop = supervisor.waitForShutdown();
    const first = await Promise.race([
      readiness.then((details) => ({ kind: "ready", details })),
      earlyStop.then((shutdown) => ({ kind: "stopped", shutdown })),
    ]);
    if (first.kind === "stopped") return first.shutdown.exitCode;

    console.log([
      "[duo] 双端网页已就绪：",
      `  KP    ${first.details.kpOrigin}`,
      `  玩家  ${first.details.playerOrigin}`,
      `  中继  ${first.details.relayOrigin}`,
      "[duo] 两个网页使用独立 Origin / IndexedDB；本地 AI 桥仅在 KP 页启用。",
      "[duo] 玩家角色草稿经房间交给 KP；按 Ctrl+C 一次关闭全部进程。",
    ].join("\n"));

    if (options.smoke) {
      console.log("[duo] smoke 只检查 KP 桥令牌、玩家无桥和中继端口；未执行任何 AI 请求。");
      return 0;
    }
    return (await earlyStop).exitCode;
  } finally {
    disposeSignals();
    await supervisor.stopAll();
    if (options.smoke) await assertPortsAvailable(options);
  }
}

class ChildSupervisor {
  constructor() {
    this.children = [];
    this.stopping = false;
    this.shutdown = new Promise((resolvePromise) => {
      this.resolveShutdown = resolvePromise;
    });
  }

  start(spec) {
    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...spec.env, NO_COLOR: "1" },
    });
    this.children.push({ child, label: spec.label });
    prefixStream(child.stdout, spec.label, process.stdout);
    prefixStream(child.stderr, spec.label, process.stderr);
    child.once("error", (error) => {
      if (!this.stopping) {
        console.error(`[duo] ${spec.label} 启动失败：${error.message}`);
        this.requestShutdown(1, `${spec.label} failed to start`);
      }
    });
    child.once("exit", (code, signal) => {
      if (!this.stopping) {
        console.error(`[duo] ${spec.label} 意外退出（${signal ?? code ?? "unknown"}），正在关闭其余进程。`);
        this.requestShutdown(code && code > 0 ? code : 1, `${spec.label} exited`);
      }
    });
  }

  requestShutdown(exitCode, reason) {
    if (this.stopping) return;
    this.stopping = true;
    this.resolveShutdown({ exitCode, reason });
  }

  waitForShutdown() {
    return this.shutdown;
  }

  async stopAll() {
    this.stopping = true;
    await Promise.all(this.children.map(({ child }) => terminateChildTree(child)));
    this.children.length = 0;
  }
}

async function runOneShot(spec) {
  const child = spawn(spec.executable, spec.args, {
    cwd: spec.cwd,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...spec.env, NO_COLOR: "1" },
  });
  prefixStream(child.stdout, spec.label, process.stdout);
  prefixStream(child.stderr, spec.label, process.stderr);

  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
    void terminateChildTree(child);
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  try {
    const result = await new Promise((resolvePromise) => {
      child.once("error", (error) => resolvePromise({ code: 1, error }));
      child.once("exit", (code, signal) => resolvePromise({ code: code ?? (signal ? 1 : 0) }));
    });
    if (result.error) console.error(`[duo] ${spec.label} 启动失败：${result.error.message}`);
    return interrupted ? 130 : result.code;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
}

function bindShutdownSignals(supervisor) {
  const handlers = new Map();
  for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129], ["SIGBREAK", 131]]) {
    const handler = () => supervisor.requestShutdown(exitCode, signal);
    try {
      process.on(signal, handler);
      handlers.set(signal, handler);
    } catch {
      // Some signals are unavailable on some platforms.
    }
  }
  return () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
}

async function verifyDuoReadiness(options) {
  const kpOrigin = `http://127.0.0.1:${options.kpPort}`;
  const playerOrigin = `http://127.0.0.1:${options.playerPort}`;
  const relayOrigin = `http://127.0.0.1:${options.relayPort}`;
  const [kpHtml, playerHtml] = await Promise.all([
    waitForHtml(kpOrigin),
    waitForHtml(playerOrigin),
    waitForTcpPort(options.relayPort),
  ]);
  readBridgeToken(kpHtml);
  if (findBridgeToken(playerHtml) !== undefined) {
    throw new Error("玩家 Vite 进程不应注入本地 AI 安全桥令牌");
  }
  return { kpOrigin, playerOrigin, relayOrigin };
}

async function waitForHtml(origin) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(800) });
      if (response.ok) return await response.text();
    } catch {
      // Service is still starting.
    }
    await delay(100);
  }
  throw new Error(`${origin} 未在 ${STARTUP_TIMEOUT_MS / 1_000} 秒内就绪`);
}

async function waitForTcpPort(port) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return;
    await delay(100);
  }
  throw new Error(`本地中继端口 ${port} 未在 ${STARTUP_TIMEOUT_MS / 1_000} 秒内就绪`);
}

function canConnect(port) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(300);
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.once("error", () => resolvePromise(false));
  });
}

function readBridgeToken(html) {
  const token = findBridgeToken(html);
  if (!token || token.length < 43) throw new Error("Vite 页面缺少本进程的安全桥令牌");
  return token;
}

function findBridgeToken(html) {
  const tag = html.match(/<meta\b[^>]*name=["']coc-room-local-ai-token["'][^>]*>/i)?.[0];
  return tag?.match(/\bcontent=["']([^"']+)["']/i)?.[1];
}

async function withIsolatedPorts(options) {
  const selected = new Set();
  const reserve = async () => {
    let port;
    do port = await reserveAvailablePort(); while (selected.has(port));
    selected.add(port);
    return port;
  };
  return {
    ...options,
    kpPort: await reserve(),
    playerPort: await reserve(),
    relayPort: await reserve(),
    open: false,
  };
}

async function reserveAvailablePort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法分配本地开发端口");
  await new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
  return address.port;
}

async function assertPortsAvailable(options) {
  // Just-terminated children (workerd in particular) can hold their socket for
  // a moment after taskkill, so poll briefly instead of failing on the first
  // probe; a genuinely occupied port still fails after the grace window.
  for (const [label, port] of [["KP", options.kpPort], ["玩家", options.playerPort], ["中继", options.relayPort]]) {
    let free = false;
    for (let attempt = 0; attempt < 20 && !free; attempt += 1) {
      free = await canListen(port);
      if (!free) await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    if (!free) throw new Error(`${label} 端口 ${port} 已被占用`);
  }
}

function canListen(port) {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePromise(true)));
  });
}

async function terminateChildTree(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await new Promise((resolvePromise) => killer.once("close", resolvePromise));
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  if (await waitForExit(child, 2_000)) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function waitForExit(child, timeoutMilliseconds) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    let timer;
    const onExit = () => {
      if (timer !== undefined) clearTimeout(timer);
      resolvePromise(true);
    };
    timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolvePromise(false);
    }, timeoutMilliseconds);
    child.once("exit", onExit);
    if (child.exitCode !== null) {
      child.removeListener("exit", onExit);
      onExit();
    }
  });
}

function prefixStream(stream, label, destination) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      if (line) destination.write(`[${label}] ${line}\n`);
      newline = pending.indexOf("\n");
    }
  });
  stream.on("end", () => {
    const line = pending.replace(/\r$/, "");
    if (line) destination.write(`[${label}] ${line}\n`);
  });
}

function parsePort(raw, name) {
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer between 1 and 65535`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

function assertDistinctPorts(options) {
  const ports = [options.kpPort, options.playerPort, options.relayPort];
  if (new Set(ports).size !== ports.length) throw new Error("KP、玩家和中继必须使用三个不同端口");
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  runDuo().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(`[duo] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
