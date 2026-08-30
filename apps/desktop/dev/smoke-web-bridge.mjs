import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE_PREFIX = "/__coc_room_local_ai/v1";
const BRIDGE_HEADER = "x-coc-room-local-ai";
const TOKEN_META_NAME = "coc-room-local-ai-token";
const STARTUP_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(currentDirectory, "..");
const viteEntry = join(desktopRoot, "node_modules", "vite", "bin", "vite.js");
const port = await reserveAvailablePort();
const origin = `http://127.0.0.1:${port}`;
const viteOutput = [];

const vite = spawn(process.execPath, [viteEntry, "--mode", "web"], {
  cwd: desktopRoot,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    COC_ROOM_WEB_PORT: String(port),
    NO_COLOR: "1",
  },
});

vite.stdout.on("data", rememberViteOutput);
vite.stderr.on("data", rememberViteOutput);

let smokePassed = false;
try {
  const html = await waitForDevelopmentPage(vite, origin);
  const token = readBridgeToken(html);

  await expectRejectedBridgeRequest(origin, {
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
  });
  await expectRejectedBridgeRequest(origin, {
    Origin: "http://127.0.0.1:9",
    "Sec-Fetch-Site": "cross-site",
    [BRIDGE_HEADER]: token,
  });

  const hmrConnected = await verifyHmrWebSocket(port);
  const status = await postJson(`${origin}${BRIDGE_PREFIX}/status`, token, {});
  assertRecord(status, "bridge status");
  if (status.available !== true) throw new Error("local bridge did not report itself as available");
  if (status.parserReady !== true) {
    throw new Error("Python parser environment is not ready; run uv sync in services/module-parser");
  }

  const requestId = "web-bridge-smoke";
  const parseResponse = await fetch(`${origin}${BRIDGE_PREFIX}/parse-module`, {
    method: "POST",
    headers: bridgeHeaders(origin, token),
    body: JSON.stringify({
      id: requestId,
      sourceText: "# Rain Station\n## Platform\nClue: an old ticket",
      sourceName: "web-bridge-smoke.md",
      provider: "codex",
      model: "",
      mock: true,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!parseResponse.ok) {
    throw new Error(`mock parser request failed with HTTP ${parseResponse.status}`);
  }
  const messages = (await parseResponse.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (!messages.some((message) => message?.request_id === requestId && message?.type === "progress")) {
    throw new Error("mock parser did not stream a progress event");
  }
  if (!messages.some((message) => message?.request_id === requestId && message?.type === "result" && message?.module)) {
    throw new Error("mock parser did not return a structured module");
  }

  const codex = typeof status.codex === "object" && status.codex !== null ? status.codex : {};
  console.log(JSON.stringify({
    page: origin,
    hmrConnected,
    bridgeSessionTokenInjected: token.length >= 43,
    parserReady: status.parserReady,
    codex: {
      installed: codex.installed === true,
      compatible: codex.compatible === true,
      authenticated: codex.authenticated === true,
    },
    deepseekKeyPresent: status.deepseekKeyPresent === true,
    mockParseMessages: messages.length,
  }, null, 2));
  smokePassed = true;
} finally {
  await terminateProcess(vite);
  await verifyServerStopped(origin);
  if (!smokePassed && viteOutput.length > 0) {
    console.error("\nVite output:\n" + viteOutput.join(""));
  }
}

function rememberViteOutput(chunk) {
  viteOutput.push(String(chunk));
  while (viteOutput.join("").length > 16_384) viteOutput.shift();
}

async function reserveAvailablePort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to reserve a development port");
  await new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
  return address.port;
}

async function waitForDevelopmentPage(child, pageOrigin) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited before startup with code ${child.exitCode}`);
    try {
      const response = await fetch(`${pageOrigin}/`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return await response.text();
    } catch {
      // The TCP listener is not ready yet.
    }
    await delay(100);
  }
  throw new Error(`Vite did not become ready within ${STARTUP_TIMEOUT_MS} ms`);
}

function readBridgeToken(html) {
  const tag = html.match(new RegExp(`<meta\\b[^>]*name=["']${TOKEN_META_NAME}["'][^>]*>`, "i"))?.[0];
  const token = tag?.match(/\bcontent=["']([^"']+)["']/i)?.[1];
  if (!token || token.length < 43) throw new Error("development HTML is missing the per-process bridge token");
  return token;
}

async function expectRejectedBridgeRequest(pageOrigin, extraHeaders) {
  const response = await fetch(`${pageOrigin}${BRIDGE_PREFIX}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: "{}",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status !== 403) throw new Error(`unsafe bridge request was not rejected (HTTP ${response.status})`);
}

async function postJson(url, token, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: bridgeHeaders(new URL(url).origin, token),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json();
  if (!response.ok) {
    const code = payload?.error?.code ?? "UNKNOWN";
    throw new Error(`bridge status request failed with HTTP ${response.status} (${code})`);
  }
  return payload;
}

function bridgeHeaders(pageOrigin, token) {
  return {
    "Content-Type": "application/json",
    Origin: pageOrigin,
    "Sec-Fetch-Site": "same-origin",
    [BRIDGE_HEADER]: token,
  };
}

async function verifyHmrWebSocket(portNumber) {
  if (typeof WebSocket !== "function") throw new Error("Node.js 22 WebSocket support is required");
  return await new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(`ws://127.0.0.1:${portNumber}`, "vite-hmr");
    const timer = setTimeout(() => {
      socket.close();
      rejectPromise(new Error("Vite HMR WebSocket did not connect"));
    }, 5_000);
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type !== "connected") return;
        clearTimeout(timer);
        socket.close();
        resolvePromise(true);
      } catch {
        // Ignore non-JSON messages until Vite sends its connected envelope.
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      rejectPromise(new Error("Vite HMR WebSocket failed"));
    }, { once: true });
  });
}

async function terminateProcess(child) {
  if (child.exitCode !== null) return;
  const exitPromise = waitForChildExit(child, 5_000);
  child.kill("SIGTERM");
  const exited = await exitPromise;
  if (exited) return;
  if (process.platform === "win32" && child.pid !== undefined) {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await new Promise((resolvePromise) => killer.once("close", resolvePromise));
  } else {
    child.kill("SIGKILL");
  }
}

function waitForChildExit(child, timeoutMilliseconds) {
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

async function verifyServerStopped(pageOrigin) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${pageOrigin}/`, { signal: AbortSignal.timeout(300) });
    } catch {
      return;
    }
    await delay(50);
  }
  throw new Error("Vite stopped but its local bridge port is still accepting requests");
}

function assertRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
