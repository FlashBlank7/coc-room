const argumentsAfterSeparator = process.argv.slice(2).filter((argument) => argument !== "--");
if (argumentsAfterSeparator.length > 1) {
  throw new Error("relay smoke accepts at most one relay origin");
}
const baseUrl = normalizeBaseUrl(argumentsAfterSeparator[0] ?? process.env.COC_ROOM_RELAY_URL ?? "http://127.0.0.1:8787");
const sockets = [];

try {
  const health = await fetchJson(`${baseUrl}/health`, { signal: AbortSignal.timeout(10_000) });
  if (health.ok !== true) throw new Error("relay health endpoint did not return ok=true");

  const hostPeerId = randomPeerId("host");
  const playerPeerId = randomPeerId("player");
  const room = await fetchJson(`${baseUrl}/v1/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ protocolVersion: 1, hostPeerId }),
    signal: AbortSignal.timeout(10_000),
  });

  const host = await joinRoom(room.websocketUrl, {
    roomId: room.roomId,
    token: room.hostToken,
    peerId: hostPeerId,
    displayName: "Smoke Host",
    role: "host",
  });
  sockets.push(host);
  const player = await joinRoom(room.websocketUrl, {
    roomId: room.roomId,
    token: room.joinToken,
    peerId: playerPeerId,
    displayName: "Smoke Player",
    role: "player",
  });
  sockets.push(player);

  const playerRequestId = crypto.randomUUID();
  const atHost = waitForMessage(
    host,
    (message) => message.kind === "relay" && message.fromPeerId === playerPeerId,
    "player-to-host relay",
  );
  player.send(JSON.stringify({
    kind: "relay",
    targetPeerId: hostPeerId,
    payload: { kind: "sync.request", requestId: playerRequestId, lastSequence: 0 },
  }));
  const playerMessage = await atHost;
  if (playerMessage.payload?.requestId !== playerRequestId) {
    throw new Error("player-to-host relay payload was changed");
  }

  const hostRequestId = crypto.randomUUID();
  const atPlayer = waitForMessage(
    player,
    (message) => message.kind === "relay" && message.fromPeerId === hostPeerId,
    "host-to-player relay",
  );
  host.send(JSON.stringify({
    kind: "relay",
    targetPeerId: playerPeerId,
    payload: { kind: "sync.request", requestId: hostRequestId, lastSequence: 7 },
  }));
  const hostMessage = await atPlayer;
  if (hostMessage.payload?.requestId !== hostRequestId || hostMessage.payload?.lastSequence !== 7) {
    throw new Error("host-to-player relay payload was changed");
  }

  process.stdout.write(`Relay smoke passed: host <-> player through ${baseUrl}\n`);
} finally {
  for (const socket of sockets) socket.close(1000, "smoke complete");
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("relay URL must be an HTTP(S) origin without credentials, query, or fragment");
  }
  return url.toString().replace(/\/$/, "");
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function joinRoom(websocketUrl, identity) {
  const socket = new WebSocket(websocketUrl);
  const requestId = crypto.randomUUID();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`join timed out for ${identity.role}`)), 10_000);
    const finish = (action, value) => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      action(value);
    };
    const onMessage = (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.kind === "ready" && message.requestId === requestId) {
        finish(resolve);
      } else if (message.kind === "error" && message.requestId === requestId) {
        finish(reject, new Error(`join failed: ${message.code}`));
      }
    };
    const onError = () => finish(reject, new Error(`WebSocket failed for ${identity.role}`));
    const onClose = () => finish(reject, new Error(`WebSocket closed before ${identity.role} was ready`));
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onClose, { once: true });
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ kind: "join", protocolVersion: 1, requestId, ...identity }));
    }, { once: true });
  });
  return socket;
}

function waitForMessage(socket, predicate, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(reject, new Error(`${label} timed out`)), 10_000);
    const finish = (action, value) => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      action(value);
    };
    const onMessage = (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (predicate(message)) finish(resolve, message);
    };
    const onClose = () => finish(reject, new Error(`${label} socket closed`));
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
  });
}

function randomPeerId(prefix) {
  return `${prefix}-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}
