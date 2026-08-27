import { DurableObject } from "cloudflare:workers";
import {
  AUTHENTICATION_GRACE_PERIOD_MS,
  HOST_TOKEN_PATTERN,
  JSON_HEADERS,
  MAX_FRAME_BYTES,
  MAX_PENDING_SOCKETS,
  MAX_PLAYERS,
  MAX_ROOM_PEERS,
  PEER_ID_PATTERN,
  PROTOCOL_VERSION,
  ROOM_ID_PATTERN,
} from "./constants";
import {
  canRoute,
  frameByteLength,
  makeError,
  parseClientMessage,
  publicPeer,
  serializeServerMessage,
} from "./protocol";
import {
  deriveJoinSecret,
  deriveRoomId,
  formatJoinToken,
  parseJoinToken,
  timingSafeStringEqual,
} from "./security";
import type {
  Env,
  ErrorCode,
  JoinMessage,
  PeerAttachment,
  ServerMessage,
  SocketAttachment,
} from "./types";

const ROOM_WEBSOCKET_PATH = /^\/v1\/rooms\/([A-Za-z0-9_-]+)\/ws$/u;
const OPEN = 1;

export class RelayRoom extends DurableObject<Env> {
  constructor(
    ctx: DurableObjectState,
    env: Env,
  ) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    this.ctx.blockConcurrencyWhile(async () => {
      // v1 briefly used this application table. Credentials are now
      // self-authenticating, so remove legacy metadata during rehydration.
      this.ctx.storage.sql.exec("DROP TABLE IF EXISTS room_metadata");
      await this.scheduleNextAlarm();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const roomId = roomIdFromRequest(request);
    if (roomId === undefined) {
      return jsonResponse(404, {
        error: "NOT_FOUND",
        message: "The room WebSocket path is malformed.",
      });
    }

    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    ) {
      return jsonResponse(426, {
        error: "WEBSOCKET_REQUIRED",
        message: "Use a WebSocket upgrade request.",
      });
    }

    this.closeExpiredPendingSockets(Date.now());
    const pendingCount = this.openSockets().filter(
      (socket) => !readAttachment(socket).authenticated,
    ).length;
    if (pendingCount >= MAX_PENDING_SOCKETS) {
      return jsonResponse(503, {
        error: "TOO_MANY_PENDING_CONNECTIONS",
        message: "The room has too many pending connections.",
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const attachment: SocketAttachment = {
      attachmentVersion: 1,
      authenticated: false,
      roomId,
      authenticationDeadlineAt: Date.now() + AUTHENTICATION_GRACE_PERIOD_MS,
    };

    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
    await this.scheduleNextAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    socket: WebSocket,
    frame: string | ArrayBuffer,
  ): Promise<void> {
    const expiredSockets = this.closeExpiredPendingSockets(Date.now());
    await this.scheduleNextAlarm();
    if (expiredSockets.has(socket)) {
      return;
    }

    if (frameByteLength(frame) > MAX_FRAME_BYTES) {
      this.failAndClose(
        socket,
        "FRAME_TOO_LARGE",
        "WebSocket frames may not exceed 64 KiB.",
        1009,
      );
      return;
    }

    if (typeof frame !== "string") {
      this.failAndClose(
        socket,
        "BINARY_UNSUPPORTED",
        "Only UTF-8 JSON text frames are supported.",
        1003,
      );
      return;
    }

    const message = parseClientMessage(frame);
    if (message === undefined) {
      if (readAttachment(socket).authenticated) {
        this.send(
          socket,
          makeError("INVALID_MESSAGE", "The message does not match protocol v1."),
        );
      } else {
        this.failAndClose(
          socket,
          "INVALID_MESSAGE",
          "The first message must be a valid protocol v1 join.",
          4003,
        );
      }
      return;
    }

    const attachment = readAttachment(socket);
    if (!attachment.authenticated) {
      if (message.kind !== "join") {
        this.failAndClose(
          socket,
          "AUTH_REQUIRED",
          "The first message must be join.",
          4003,
          message.requestId,
        );
        return;
      }

      await this.join(socket, attachment, message);
      return;
    }

    switch (message.kind) {
      case "join":
        this.send(
          socket,
          makeError(
            "INVALID_MESSAGE",
            "This connection has already joined.",
            message.requestId,
          ),
        );
        return;

      case "presence": {
        const updated: PeerAttachment = {
          ...attachment,
          status: message.status,
        };
        socket.serializeAttachment(updated);
        this.broadcast({
          kind: "presence",
          protocolVersion: PROTOCOL_VERSION,
          action: "updated",
          peer: publicPeer(updated),
        });
        return;
      }

      case "signal":
      case "relay":
        this.route(socket, attachment, message);
        return;

      case "leave":
        await this.remove(socket, attachment);
        safeClose(socket, 1000, "Client left");
        await this.scheduleNextAlarm();
        return;
    }
  }

  async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    void reason;
    void wasClean;
    const attachment = readAttachment(socket);
    if (attachment.authenticated) {
      await this.remove(socket, attachment);
    }

    safeClose(socket, code, "Connection closed");
    await this.scheduleNextAlarm();
  }

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    void error;
    const attachment = readAttachment(socket);
    if (attachment.authenticated) {
      await this.remove(socket, attachment);
    }
    safeClose(socket, 1011, "WebSocket error");
    await this.scheduleNextAlarm();
  }

  async alarm(): Promise<void> {
    this.closeExpiredPendingSockets(Date.now());
    await this.scheduleNextAlarm();
  }

  private async join(
    socket: WebSocket,
    pending: Extract<SocketAttachment, { authenticated: false }>,
    message: JoinMessage,
  ): Promise<void> {
    if (!timingSafeStringEqual(message.roomId, pending.roomId)) {
      this.failAndClose(
        socket,
        "NOT_FOUND",
        "The join roomId does not match the WebSocket room.",
        4004,
        message.requestId,
      );
      return;
    }

    const hostPeerId = await authenticateJoin(pending.roomId, message);
    if (hostPeerId === undefined) {
      this.failAndClose(
        socket,
        "INVALID_TOKEN",
        "The room token is invalid for the requested role.",
        4003,
        message.requestId,
      );
      return;
    }

    if (message.role === "player" && message.peerId === hostPeerId) {
      this.failAndClose(
        socket,
        "PEER_ID_RESERVED",
        "That peer identifier is reserved for the room host.",
        4003,
        message.requestId,
      );
      return;
    }

    let peers = this.peerSockets(socket);
    if (
      peers.some(
        ({ attachment }) =>
          attachment.roomId !== pending.roomId ||
          attachment.hostPeerId !== hostPeerId,
      )
    ) {
      this.failAndClose(
        socket,
        "INVALID_TOKEN",
        "The room credential does not match the active room.",
        4003,
        message.requestId,
      );
      return;
    }

    const duplicate = peers.find(
      ({ attachment }) => attachment.peerId === message.peerId,
    );
    if (duplicate !== undefined) {
      if (message.role === "host" && duplicate.attachment.role === "host") {
        this.markPending(duplicate.socket, duplicate.attachment.roomId);
        safeClose(duplicate.socket, 4001, "Host reconnected");
        peers = peers.filter(
          ({ socket: peerSocket }) => peerSocket !== duplicate.socket,
        );
      } else {
        this.failAndClose(
          socket,
          "PEER_EXISTS",
          "That peer identifier is already connected.",
          4009,
          message.requestId,
        );
        return;
      }
    }

    if (
      message.role === "host" &&
      peers.some(({ attachment }) => attachment.role === "host")
    ) {
      this.failAndClose(
        socket,
        "HOST_EXISTS",
        "This room already has an active host.",
        4009,
        message.requestId,
      );
      return;
    }

    const playerCount = peers.filter(
      ({ attachment }) => attachment.role === "player",
    ).length;
    if (
      peers.length >= MAX_ROOM_PEERS ||
      (message.role === "player" && playerCount >= MAX_PLAYERS)
    ) {
      this.failAndClose(
        socket,
        "ROOM_FULL",
        "The room supports one host and at most seven players.",
        4004,
        message.requestId,
      );
      return;
    }

    const joined: PeerAttachment = {
      attachmentVersion: 1,
      authenticated: true,
      roomId: pending.roomId,
      hostPeerId,
      peerId: message.peerId,
      displayName: message.displayName.trim(),
      role: message.role,
      status: "online",
      joinedAt: Date.now(),
    };
    socket.serializeAttachment(joined);
    await this.scheduleNextAlarm();

    const existingPeers = peers.map(({ attachment }) => publicPeer(attachment));
    this.send(socket, {
      kind: "ready",
      protocolVersion: PROTOCOL_VERSION,
      ok: true,
      roomId: pending.roomId,
      self: publicPeer(joined),
      peers: existingPeers,
      ...(message.requestId === undefined
        ? {}
        : { requestId: message.requestId }),
    });

    this.broadcast(
      {
        kind: "presence",
        protocolVersion: PROTOCOL_VERSION,
        action: "joined",
        peer: publicPeer(joined),
      },
      socket,
    );
  }

  private route(
    senderSocket: WebSocket,
    sender: PeerAttachment,
    message: Extract<
      NonNullable<ReturnType<typeof parseClientMessage>>,
      { kind: "signal" | "relay" }
    >,
  ): void {
    const target = this.peerSockets().find(
      ({ attachment }) => attachment.peerId === message.targetPeerId,
    );

    if (target === undefined) {
      this.send(
        senderSocket,
        makeError(
          "TARGET_NOT_FOUND",
          "The target peer is not connected.",
          message.requestId,
        ),
      );
      return;
    }

    if (!canRoute(sender, target.attachment)) {
      this.send(
        senderSocket,
        makeError(
          "TOPOLOGY_VIOLATION",
          "Messages must travel directly between the host and a player.",
          message.requestId,
        ),
      );
      return;
    }

    const forwarded: ServerMessage =
      message.kind === "signal"
        ? {
            kind: "signal",
            protocolVersion: PROTOCOL_VERSION,
            fromPeerId: sender.peerId,
            data: message.data,
            ...(message.requestId === undefined
              ? {}
              : { requestId: message.requestId }),
          }
        : {
            kind: "relay",
            protocolVersion: PROTOCOL_VERSION,
            fromPeerId: sender.peerId,
            payload: message.payload,
            ...(message.requestId === undefined
              ? {}
              : { requestId: message.requestId }),
          };
    const serialized = serializeServerMessage(forwarded);
    if (serialized === undefined) {
      this.send(
        senderSocket,
        makeError(
          "FRAME_TOO_LARGE",
          "The routed envelope exceeds the 64 KiB frame limit; split the payload.",
          message.requestId,
        ),
      );
      return;
    }

    safeSend(target.socket, serialized);
  }

  private async remove(
    socket: WebSocket,
    peer: PeerAttachment,
  ): Promise<void> {
    this.markPending(socket, peer.roomId);
    this.broadcast(
      {
        kind: "presence",
        protocolVersion: PROTOCOL_VERSION,
        action: "left",
        peer: { peerId: peer.peerId },
      },
      socket,
    );
  }

  private markPending(socket: WebSocket, roomId: string): void {
    const attachment: SocketAttachment = {
      attachmentVersion: 1,
      authenticated: false,
      roomId,
      authenticationDeadlineAt: Date.now(),
    };
    socket.serializeAttachment(attachment);
  }

  private closeExpiredPendingSockets(now: number): Set<WebSocket> {
    const expired = new Set<WebSocket>();
    for (const socket of this.openSockets()) {
      const attachment = readAttachment(socket);
      if (
        !attachment.authenticated &&
        attachment.authenticationDeadlineAt <= now
      ) {
        expired.add(socket);
        safeClose(socket, 4003, "Authentication timed out");
      }
    }
    return expired;
  }

  private async scheduleNextAlarm(): Promise<void> {
    let nextDeadline: number | undefined;
    for (const socket of this.openSockets()) {
      const attachment = readAttachment(socket);
      if (
        !attachment.authenticated &&
        (nextDeadline === undefined ||
          attachment.authenticationDeadlineAt < nextDeadline)
      ) {
        nextDeadline = attachment.authenticationDeadlineAt;
      }
    }

    const scheduledAlarm = await this.ctx.storage.getAlarm();
    if (nextDeadline === undefined) {
      if (scheduledAlarm !== null) {
        await this.ctx.storage.deleteAlarm();
      }
      return;
    }

    if (scheduledAlarm !== nextDeadline) {
      await this.ctx.storage.setAlarm(nextDeadline);
    }
  }

  private openSockets(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((socket) => socket.readyState === OPEN);
  }

  private peerSockets(exclude?: WebSocket): Array<{
    socket: WebSocket;
    attachment: PeerAttachment;
  }> {
    const peers: Array<{ socket: WebSocket; attachment: PeerAttachment }> = [];
    for (const socket of this.openSockets()) {
      if (socket === exclude) {
        continue;
      }
      const attachment = readAttachment(socket);
      if (attachment.authenticated) {
        peers.push({ socket, attachment });
      }
    }
    return peers;
  }

  private broadcast(message: ServerMessage, exclude?: WebSocket): void {
    const serialized = serializeServerMessage(message);
    if (serialized === undefined) {
      return;
    }

    for (const { socket } of this.peerSockets(exclude)) {
      safeSend(socket, serialized);
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    const serialized = serializeServerMessage(message);
    if (serialized !== undefined) {
      safeSend(socket, serialized);
    }
  }

  private failAndClose(
    socket: WebSocket,
    code: ErrorCode,
    message: string,
    closeCode: number,
    requestId?: string,
  ): void {
    this.send(socket, makeError(code, message, requestId));
    safeClose(socket, closeCode, code);
  }
}

async function authenticateJoin(
  roomId: string,
  message: JoinMessage,
): Promise<string | undefined> {
  if (message.role === "host") {
    if (!HOST_TOKEN_PATTERN.test(message.token)) {
      return undefined;
    }
    const joinSecret = await deriveJoinSecret(message.token);
    const joinToken = formatJoinToken(message.peerId, joinSecret);
    const expectedRoomId = await deriveRoomId(joinToken);
    return timingSafeStringEqual(expectedRoomId, roomId)
      ? message.peerId
      : undefined;
  }

  const parsed = parseJoinToken(message.token);
  if (parsed === undefined || !PEER_ID_PATTERN.test(parsed.hostPeerId)) {
    return undefined;
  }
  const expectedRoomId = await deriveRoomId(message.token);
  return timingSafeStringEqual(expectedRoomId, roomId)
    ? parsed.hostPeerId
    : undefined;
}

function roomIdFromRequest(request: Request): string | undefined {
  const match = ROOM_WEBSOCKET_PATH.exec(new URL(request.url).pathname);
  const roomId = match?.[1];
  return roomId !== undefined && ROOM_ID_PATTERN.test(roomId)
    ? roomId
    : undefined;
}

function readAttachment(socket: WebSocket): SocketAttachment {
  const attachment = socket.deserializeAttachment() as unknown;
  if (!isRecord(attachment) || attachment.attachmentVersion !== 1) {
    return invalidAttachment();
  }

  if (
    attachment.authenticated === false &&
    typeof attachment.roomId === "string" &&
    ROOM_ID_PATTERN.test(attachment.roomId) &&
    typeof attachment.authenticationDeadlineAt === "number" &&
    Number.isFinite(attachment.authenticationDeadlineAt)
  ) {
    return attachment as unknown as SocketAttachment;
  }

  if (
    attachment.authenticated === true &&
    typeof attachment.roomId === "string" &&
    ROOM_ID_PATTERN.test(attachment.roomId) &&
    typeof attachment.hostPeerId === "string" &&
    PEER_ID_PATTERN.test(attachment.hostPeerId) &&
    typeof attachment.peerId === "string" &&
    PEER_ID_PATTERN.test(attachment.peerId) &&
    typeof attachment.displayName === "string" &&
    (attachment.role === "host" || attachment.role === "player") &&
    (attachment.status === "online" || attachment.status === "away") &&
    typeof attachment.joinedAt === "number" &&
    Number.isFinite(attachment.joinedAt)
  ) {
    return attachment as unknown as SocketAttachment;
  }

  return invalidAttachment();
}

function invalidAttachment(): SocketAttachment {
  // Unknown or legacy attachments fail closed on the next event/alarm.
  return {
    attachmentVersion: 1,
    authenticated: false,
    roomId: "",
    authenticationDeadlineAt: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeSend(socket: WebSocket, serialized: string): void {
  try {
    if (socket.readyState === OPEN) {
      socket.send(serialized);
    }
  } catch {
    // Disconnect races are expected. Never log frames or payload-derived errors.
  }
}

function safeClose(socket: WebSocket, code: number, reason: string): void {
  try {
    if (socket.readyState !== WebSocket.CLOSED) {
      socket.close(code, reason);
    }
  } catch {
    // Close/error callbacks can race; no application data is logged.
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}
