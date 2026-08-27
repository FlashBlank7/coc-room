import { env, exports } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTHENTICATION_GRACE_PERIOD_MS,
  MAX_FRAME_BYTES,
  MAX_PENDING_SOCKETS,
} from "../src/constants";
import type { CreateRoomResponse, ServerMessage } from "../src/types";

const sockets: WebSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    try {
      socket.close(1000, "Test complete");
    } catch {
      // The server may already have closed a rejected connection.
    }
  }
});

describe("relay Worker", () => {
  it("creates a SQLite-backed room without storing plaintext tokens or messages", async () => {
    const room = await createRoom();
    expect(room.roomId).toMatch(/^[A-Za-z0-9_-]{16,64}$/u);
    expect(room.hostPeerId).toBe("host-peer");
    expect(room.hostToken).not.toBe(room.joinToken);
    expect(room.websocketUrl).toContain(`/v1/rooms/${room.roomId}/ws`);

    const id = env.ROOMS.idFromName(room.roomId);
    const stub = env.ROOMS.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const metadata = state.storage.sql
        .exec<
          Record<string, SqlStorageValue> & {
            room_id: string;
            host_peer_id: string;
            host_token_hash: string;
            join_token_hash: string;
          }
        >(
          "SELECT room_id, host_peer_id, host_token_hash, join_token_hash FROM room_metadata",
        )
        .one();

      expect(metadata.room_id).toBe(room.roomId);
      expect(metadata.host_peer_id).toBe(room.hostPeerId);
      expect(metadata.host_token_hash).not.toBe(room.hostToken);
      expect(metadata.join_token_hash).not.toBe(room.joinToken);

      const applicationTables = state.storage.sql
        .exec<Record<string, SqlStorageValue> & { name: string }>(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .toArray()
        .map(({ name }) => name);
      expect(applicationTables).toEqual(["room_metadata"]);
    });
  });

  it("requires a valid host peer ID when creating a room", async () => {
    for (const body of [{}, { hostPeerId: "short" }, { hostPeerId: "bad peer id" }]) {
      const response = await exports.default.fetch("https://relay.test/v1/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "INVALID_CREATE_REQUEST",
      });
    }
  });

  it("reserves the host peer ID even while the host is offline", async () => {
    const room = await createRoom("reserved-host");

    const squatter = await connect(room.websocketUrl);
    const squatterError = nextMessage(squatter);
    squatter.send(
      JSON.stringify({
        kind: "join",
        protocolVersion: 1,
        roomId: room.roomId,
        token: room.joinToken,
        peerId: room.hostPeerId,
        displayName: "Squatter",
        role: "player",
      }),
    );
    expect(await squatterError).toMatchObject({
      kind: "error",
      code: "PEER_ID_RESERVED",
    });

    const impostor = await connect(room.websocketUrl);
    const impostorError = nextMessage(impostor);
    impostor.send(
      JSON.stringify({
        kind: "join",
        protocolVersion: 1,
        roomId: room.roomId,
        token: room.hostToken,
        peerId: "other-host",
        displayName: "Impostor",
        role: "host",
      }),
    );
    expect(await impostorError).toMatchObject({
      kind: "error",
      code: "HOST_PEER_ID_MISMATCH",
    });

    const host = await join(
      room.websocketUrl,
      room.hostToken,
      room.hostPeerId,
      "host",
    );
    expect(host.readyState).toBe(WebSocket.OPEN);
  });

  it("routes signaling and relay frames only between host and players", async () => {
    const room = await createRoom();
    const host = await connect(room.websocketUrl);
    const hostAck = nextMessage(host);
    host.send(
      JSON.stringify({
        kind: "join",
        protocolVersion: 1,
        roomId: room.roomId,
        token: room.hostToken,
        peerId: "host-peer",
        displayName: "Keeper",
        role: "host",
      }),
    );
    expect(await hostAck).toMatchObject({ kind: "ready", ok: true, peers: [] });

    const player = await connect(room.websocketUrl);
    const playerAck = nextMessage(player);
    const hostPresence = nextMessage(host);
    player.send(
      JSON.stringify({
        kind: "join",
        protocolVersion: 1,
        roomId: room.roomId,
        token: room.joinToken,
        peerId: "player-1",
        displayName: "Investigator",
        role: "player",
      }),
    );
    expect(await playerAck).toMatchObject({
      kind: "ready",
      ok: true,
      peers: [{ peerId: "host-peer", role: "host" }],
    });
    expect(await hostPresence).toMatchObject({
      kind: "presence",
      action: "joined",
      peer: { peerId: "player-1" },
    });

    const offer = nextMessage(host);
    player.send(
      JSON.stringify({
        kind: "signal",
        targetPeerId: "host-peer",
        requestId: "offer-1",
        data: { type: "offer", sdp: "test" },
      }),
    );
    expect(await offer).toMatchObject({
      kind: "signal",
      fromPeerId: "player-1",
      requestId: "offer-1",
      data: { type: "offer", sdp: "test" },
    });

    const relayed = nextMessage(player);
    host.send(
      JSON.stringify({
        kind: "relay",
        targetPeerId: "player-1",
        payload: { chunk: 1, total: 1, body: "authoritative-event" },
      }),
    );
    expect(await relayed).toMatchObject({
      kind: "relay",
      fromPeerId: "host-peer",
    });

    const away = nextMessage(host);
    player.send(JSON.stringify({ kind: "presence", status: "away" }));
    expect(await away).toMatchObject({
      kind: "presence",
      action: "updated",
      peer: { peerId: "player-1", status: "away" },
    });

    const left = nextMessage(host);
    player.send(JSON.stringify({ kind: "leave" }));
    expect(await left).toMatchObject({
      kind: "presence",
      action: "left",
      peer: { peerId: "player-1" },
    });
  });

  it("rejects bad tokens, a mismatched host identity, and an eighth player", async () => {
    const room = await createRoom();
    const host = await join(
      room.websocketUrl,
      room.hostToken,
      "host-peer",
      "host",
    );

    const invalid = await connect(room.websocketUrl);
    const invalidError = nextMessage(invalid);
    invalid.send(
      JSON.stringify({
        kind: "join",
        protocolVersion: 1,
        roomId: room.roomId,
        token: "invalid-token-value-0000",
        peerId: "bad-peer-1",
        displayName: "Bad token",
        role: "player",
      }),
    );
    expect(await invalidError).toMatchObject({
      kind: "error",
      code: "INVALID_TOKEN",
    });

    const otherHost = await connect(room.websocketUrl);
    const hostError = nextMessage(otherHost);
    otherHost.send(
      JSON.stringify({
        kind: "join",
        protocolVersion: 1,
        roomId: room.roomId,
        token: room.hostToken,
        peerId: "other-host",
        displayName: "Other host",
        role: "host",
      }),
    );
    expect(await hostError).toMatchObject({
      kind: "error",
      code: "HOST_PEER_ID_MISMATCH",
    });

    for (let index = 1; index <= 7; index += 1) {
      await join(
        room.websocketUrl,
        room.joinToken,
        `player-${index}`,
        "player",
      );
    }

    const eighth = await connect(room.websocketUrl);
    const fullError = nextMessage(eighth);
    eighth.send(
      JSON.stringify({
        kind: "join",
        protocolVersion: 1,
        roomId: room.roomId,
        token: room.joinToken,
        peerId: "player-8",
        displayName: "Player 8",
        role: "player",
      }),
    );
    expect(await fullError).toMatchObject({ kind: "error", code: "ROOM_FULL" });
    expect(host.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects player-to-player routing", async () => {
    const room = await createRoom();
    await join(room.websocketUrl, room.hostToken, "host-peer", "host");
    const first = await join(
      room.websocketUrl,
      room.joinToken,
      "player-1",
      "player",
    );
    await join(
      room.websocketUrl,
      room.joinToken,
      "player-2",
      "player",
    );

    const error = nextMessage(first, (message) => message.kind === "error");
    first.send(
      JSON.stringify({
        kind: "relay",
        targetPeerId: "player-2",
        payload: "not allowed",
      }),
    );
    expect(await error).toMatchObject({
      kind: "error",
      code: "TOPOLOGY_VIOLATION",
    });
  });

  it("restores peer attachments after Durable Object hibernation", async () => {
    const room = await createRoom();
    const host = await join(
      room.websocketUrl,
      room.hostToken,
      "host-peer",
      "host",
    );
    const player = await join(
      room.websocketUrl,
      room.joinToken,
      "player-1",
      "player",
    );

    const id = env.ROOMS.idFromName(room.roomId);
    await evictDurableObject(env.ROOMS.get(id));

    const signal = nextMessage(host, (message) => message.kind === "signal");
    player.send(
      JSON.stringify({
        kind: "signal",
        targetPeerId: "host-peer",
        data: { candidate: "after-hibernation" },
      }),
    );
    expect(await signal).toMatchObject({
      kind: "signal",
      fromPeerId: "player-1",
      data: { candidate: "after-hibernation" },
    });
  });

  it("expires stale pending sockets before enforcing the pending limit", async () => {
    const room = await createRoom();
    const pendingSockets = await Promise.all(
      Array.from({ length: MAX_PENDING_SOCKETS }, () =>
        connect(room.websocketUrl),
      ),
    );
    const saturatedResponse = await exports.default.fetch(
      websocketRequestUrl(room.websocketUrl),
      { headers: { Upgrade: "websocket" } },
    );
    expect(saturatedResponse.status).toBe(503);
    await expect(saturatedResponse.json()).resolves.toMatchObject({
      error: "TOO_MANY_PENDING_CONNECTIONS",
    });

    const pendingCloses = pendingSockets.map((socket) => nextClose(socket));
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room.roomId));

    await runInDurableObject(stub, async (_instance, state) => {
      const serverSockets = state.getWebSockets();
      expect(serverSockets).toHaveLength(MAX_PENDING_SOCKETS);
      for (const socket of serverSockets) {
        const attachment = socket.deserializeAttachment() as {
          authenticated: boolean;
          authenticationDeadlineAt: number;
        };
        expect(attachment.authenticated).toBe(false);
        expect(attachment.authenticationDeadlineAt).toBeGreaterThan(
          Date.now(),
        );
        socket.serializeAttachment({
          ...attachment,
          authenticationDeadlineAt: Date.now() - 1,
        });
      }
    });
    await evictDurableObject(stub);

    const replacement = await connect(room.websocketUrl);
    expect(replacement.readyState).toBe(WebSocket.OPEN);
    await expect(Promise.all(pendingCloses)).resolves.toEqual(
      Array.from({ length: MAX_PENDING_SOCKETS }, () => ({ code: 4003 })),
    );
  });

  it("closes an expired pending socket from its persisted alarm after hibernation", async () => {
    const room = await createRoom();
    const pending = await connect(room.websocketUrl);
    const closed = nextClose(pending);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room.roomId));

    await runInDurableObject(stub, async (_instance, state) => {
      const [serverSocket] = state.getWebSockets();
      expect(serverSocket).toBeDefined();
      const attachment = serverSocket?.deserializeAttachment() as {
        authenticationDeadlineAt: number;
      };
      expect(
        attachment.authenticationDeadlineAt - Date.now(),
      ).toBeLessThanOrEqual(AUTHENTICATION_GRACE_PERIOD_MS);
      serverSocket?.serializeAttachment({
        attachmentVersion: 1,
        authenticated: false,
        authenticationDeadlineAt: Date.now() - 1,
      });
    });
    await evictDurableObject(stub);

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expect(closed).resolves.toEqual({ code: 4003 });
  });

  it("closes connections that exceed the 64 KiB frame limit", async () => {
    const room = await createRoom();
    const host = await join(
      room.websocketUrl,
      room.hostToken,
      "host-peer",
      "host",
    );

    const closed = nextClose(host);
    host.send("x".repeat(MAX_FRAME_BYTES + 1));
    expect(await closed).toMatchObject({ code: 1009 });
  });
});

async function createRoom(hostPeerId = "host-peer"): Promise<CreateRoomResponse> {
  const response = await exports.default.fetch("https://relay.test/v1/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostPeerId }),
  });
  expect(response.status).toBe(201);
  return response.json<CreateRoomResponse>();
}

async function connect(url: string): Promise<WebSocket> {
  const response = await exports.default.fetch(websocketRequestUrl(url), {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) {
    throw new Error("WebSocket upgrade did not return a client socket");
  }
  socket.accept();
  sockets.push(socket);
  return socket;
}

function websocketRequestUrl(url: string): string {
  const requestUrl = new URL(url);
  requestUrl.protocol = requestUrl.protocol === "wss:" ? "https:" : "http:";
  return requestUrl.toString();
}

async function join(
  url: string,
  token: string,
  peerId: string,
  role: "host" | "player",
): Promise<WebSocket> {
  const socket = await connect(url);
  const ack = nextMessage(socket);
  socket.send(
    JSON.stringify({
      kind: "join",
      protocolVersion: 1,
      roomId: roomIdFromUrl(url),
      token,
      peerId,
      displayName: peerId,
      role,
    }),
  );
  expect(await ack).toMatchObject({ kind: "ready", ok: true });
  return socket;
}

function roomIdFromUrl(url: string): string {
  const segments = new URL(url).pathname.split("/");
  const roomId = segments.at(-2);
  if (roomId === undefined) {
    throw new Error("Missing room ID in WebSocket URL");
  }
  return roomId;
}

function nextMessage(
  socket: WebSocket,
  predicate: (message: ServerMessage) => boolean = () => true,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for a relay message"));
    }, 2_000);

    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      if (!predicate(message)) {
        return;
      }
      cleanup();
      resolve(message);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Socket closed before a relay message arrived"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
    };

    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
  });
}

function nextClose(socket: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("close", onClose);
      reject(new Error("Timed out waiting for the relay socket to close"));
    }, 2_000);
    const onClose = (event: CloseEvent) => {
      clearTimeout(timeout);
      socket.removeEventListener("close", onClose);
      resolve({ code: event.code });
    };
    socket.addEventListener("close", onClose);
  });
}
