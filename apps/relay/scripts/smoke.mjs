import assert from "node:assert/strict";
import {
  MAX_RELAY_FRAME_BYTES,
  RelayFragmentReassembler,
  createRelayFragments,
} from "@coc-room/protocol";

const argumentsAfterSeparator = process.argv.slice(2).filter((argument) => argument !== "--");
if (argumentsAfterSeparator.length > 1) {
  throw new Error("relay smoke accepts at most one relay origin");
}
const baseUrl = normalizeBaseUrl(argumentsAfterSeparator[0] ?? process.env.COC_ROOM_RELAY_URL ?? "http://127.0.0.1:8787");
const sockets = [];

try {
  const health = await fetchJson(`${baseUrl}/health`, { signal: AbortSignal.timeout(10_000) });
  if (health.ok !== true) throw new Error("relay health endpoint did not return ok=true");
  assert.equal(
    health.maxFrameBytes,
    MAX_RELAY_FRAME_BYTES,
    "relay and shared protocol disagree on the frame limit",
  );

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

  const largeMessage = largeUnicodeRoomMessage(room.roomId, hostPeerId);
  const ordered = await relayFragmentedMessage({
    sender: host,
    receiver: player,
    targetPeerId: playerPeerId,
    fromPeerId: hostPeerId,
    message: largeMessage,
    order: "normal",
  });
  const reversed = await relayFragmentedMessage({
    sender: host,
    receiver: player,
    targetPeerId: playerPeerId,
    fromPeerId: hostPeerId,
    message: largeMessage,
    order: "reverse",
  });

  process.stdout.write(
    `Forced-relay smoke passed through ${baseUrl}: small host <-> player messages; ` +
      `${ordered.messageBytes} byte Unicode RoomWireMessage in ${ordered.fragmentCount} fragments ` +
      `(normal and reverse order, duplicate delivery suppressed, max actual frame ` +
      `${Math.max(ordered.maximumFrameBytes, reversed.maximumFrameBytes)} bytes)\n`,
  );
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

function largeUnicodeRoomMessage(roomId, hostPeerId) {
  return {
    kind: "event",
    event: {
      protocolVersion: 1,
      roomId,
      eventId: crypto.randomUUID(),
      sequence: 8,
      sender: {
        peerId: hostPeerId,
        displayName: "见世之蝶主持人",
        role: "host",
      },
      type: "content.revealed",
      occurredAt: new Date().toISOString(),
      payload: {
        moduleId: "module-butterfly-smoke",
        revision: 1,
        contentId: "handout-unicode-smoke",
        contentType: "handout",
        title: "见世之蝶：Unicode 大型手记",
        body: "见世之蝶🦋调查员记录：".repeat(3_500),
      },
    },
  };
}

async function relayFragmentedMessage({
  sender,
  receiver,
  targetPeerId,
  fromPeerId,
  message,
  order,
}) {
  const transferId = crypto.randomUUID();
  const fragments = createRelayFragments(message, transferId);
  const messageBytes = utf8Bytes(JSON.stringify(message));
  assert.ok(
    messageBytes > MAX_RELAY_FRAME_BYTES,
    `fragment smoke message must exceed ${MAX_RELAY_FRAME_BYTES} bytes`,
  );
  assert.ok(fragments.length > 1, "large relay message was not fragmented");

  const orderedFragments = order === "reverse" ? [...fragments].reverse() : fragments;
  const transmittedFragments = [...orderedFragments, ...orderedFragments];
  const expectedChunkIndices = transmittedFragments.map((fragment) => fragment.chunkIndex);
  const receiving = collectFragmentedRelay(receiver, {
    fromPeerId,
    transferId,
    expectedChunkIndices,
  });

  let maximumOutboundFrameBytes = 0;
  for (const fragment of transmittedFragments) {
    const frame = JSON.stringify({
      kind: "relay",
      targetPeerId,
      payload: fragment,
    });
    const frameBytes = utf8Bytes(frame);
    assert.ok(
      frameBytes <= MAX_RELAY_FRAME_BYTES,
      `outbound relay frame is ${frameBytes} bytes`,
    );
    maximumOutboundFrameBytes = Math.max(maximumOutboundFrameBytes, frameBytes);
    sender.send(frame);
  }

  const received = await receiving;
  assert.deepEqual(received.message, message);
  assert.equal(received.message.kind, "event");
  assert.equal(received.message.event.type, "content.revealed");
  assert.equal(received.message.event.payload.body, message.event.payload.body);
  return {
    fragmentCount: fragments.length,
    messageBytes,
    maximumFrameBytes: Math.max(
      maximumOutboundFrameBytes,
      received.maximumInboundFrameBytes,
    ),
  };
}

function collectFragmentedRelay(
  socket,
  { fromPeerId, transferId, expectedChunkIndices },
) {
  return new Promise((resolve, reject) => {
    const reassembler = new RelayFragmentReassembler();
    const delivered = [];
    const observedChunkIndices = [];
    let maximumInboundFrameBytes = 0;
    let settled = false;
    const timeout = setTimeout(
      () => finish(reject, new Error("fragmented relay timed out")),
      20_000,
    );

    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      action(value);
    };
    const onMessage = (event) => {
      try {
        assert.equal(typeof event.data, "string", "relay returned a non-text frame");
        const message = JSON.parse(event.data);
        if (message.kind === "error") {
          finish(reject, new Error(`fragment relay failed: ${message.code}`));
          return;
        }
        if (
          message.kind !== "relay" ||
          message.fromPeerId !== fromPeerId ||
          message.payload?.kind !== "transport.fragment" ||
          message.payload.transferId !== transferId
        ) {
          return;
        }

        const frameBytes = utf8Bytes(event.data);
        assert.ok(
          frameBytes <= MAX_RELAY_FRAME_BYTES,
          `inbound relay frame is ${frameBytes} bytes`,
        );
        maximumInboundFrameBytes = Math.max(maximumInboundFrameBytes, frameBytes);
        observedChunkIndices.push(message.payload.chunkIndex);
        const result = reassembler.add(fromPeerId, message.payload);
        if (result !== undefined) delivered.push(result);

        if (observedChunkIndices.length === expectedChunkIndices.length) {
          assert.deepEqual(observedChunkIndices, expectedChunkIndices);
          assert.equal(delivered.length, 1, "fragmented message was not delivered exactly once");
          assert.equal(reassembler.inflightTransfers, 0);
          assert.equal(reassembler.bufferedBytes, 0);
          finish(resolve, {
            message: delivered[0],
            maximumInboundFrameBytes,
          });
        }
      } catch (error) {
        finish(reject, error);
      }
    };
    const onError = () => finish(reject, new Error("fragment relay WebSocket failed"));
    const onClose = () => finish(reject, new Error("fragment relay WebSocket closed"));

    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onClose, { once: true });
  });
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}
