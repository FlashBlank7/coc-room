import { DurableObject } from "cloudflare:workers";
import {
  AUTHENTICATION_GRACE_PERIOD_MS,
  EMPTY_ROOM_TTL_MS,
  JSON_HEADERS,
  MAX_FRAME_BYTES,
  MAX_PENDING_SOCKETS,
  MAX_PLAYERS,
  MAX_ROOM_PEERS,
  PEER_ID_PATTERN,
  PROTOCOL_VERSION,
  ROOM_ID_PATTERN,
  UNCLAIMED_ROOM_TTL_MS,
} from "./constants";
import {
  canRoute,
  frameByteLength,
  makeError,
  parseClientMessage,
  publicPeer,
  serializeServerMessage,
} from "./protocol";
import { sha256Base64Url, timingSafeStringEqual } from "./security";
import type {
  Env,
  ErrorCode,
  PeerAttachment,
  ServerMessage,
  SocketAttachment,
  StoredRoomMetadata,
} from "./types";

const INTERNAL_CREATE_PATH = "/__internal/create";
const OPEN = 1;

export class RelayRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(
    ctx: DurableObjectState,
    env: Env,
  ) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        room_id TEXT NOT NULL,
        host_peer_id TEXT NOT NULL,
        host_token_hash TEXT NOT NULL,
        join_token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        host_joined_at TEXT,
        empty_expires_at INTEGER
      ) STRICT
    `);
    const lifecycleColumnsAdded = this.ensureLifecycleColumns();
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    this.ctx.blockConcurrencyWhile(async () => {
      if (lifecycleColumnsAdded) {
        this.reconcileLegacyLifecycle(Date.now());
      }
      await this.scheduleNextAlarm();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === INTERNAL_CREATE_PATH) {
      return this.createRoom(request);
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

    const now = Date.now();
    this.closeExpiredPendingSockets(now);
    await this.expireRoomIfEligible(now);
    if (this.metadata() === undefined) {
      return jsonResponse(404, {
        error: "ROOM_NOT_FOUND",
        message: "The room has not been created.",
      });
    }

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
      authenticationDeadlineAt:
        Date.now() + AUTHENTICATION_GRACE_PERIOD_MS,
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

      await this.join(socket, message);
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
    const now = Date.now();
    this.closeExpiredPendingSockets(now);
    if (await this.expireRoomIfEligible(now)) {
      return;
    }
    await this.scheduleNextAlarm();
  }

  private async createRoom(request: Request): Promise<Response> {
    await this.expireRoomIfEligible(Date.now());
    if (this.metadata() !== undefined) {
      return jsonResponse(409, {
        error: "ROOM_EXISTS",
        message: "A room with this identifier already exists.",
      });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, {
        error: "INVALID_CREATE_REQUEST",
        message: "The create request is invalid.",
      });
    }

    if (
      typeof body !== "object" ||
      body === null ||
      !("roomId" in body) ||
      !("hostPeerId" in body) ||
      !("hostToken" in body) ||
      !("joinToken" in body) ||
      typeof body.roomId !== "string" ||
      typeof body.hostPeerId !== "string" ||
      typeof body.hostToken !== "string" ||
      typeof body.joinToken !== "string" ||
      !ROOM_ID_PATTERN.test(body.roomId) ||
      !PEER_ID_PATTERN.test(body.hostPeerId) ||
      body.hostToken.length < 20 ||
      body.hostToken.length > 128 ||
      body.joinToken.length < 20 ||
      body.joinToken.length > 128 ||
      body.hostToken === body.joinToken
    ) {
      return jsonResponse(400, {
        error: "INVALID_CREATE_REQUEST",
        message: "The create request is invalid.",
      });
    }

    const [hostTokenHash, joinTokenHash] = await Promise.all([
      sha256Base64Url(body.hostToken),
      sha256Base64Url(body.joinToken),
    ]);

    this.sql.exec(
      `INSERT INTO room_metadata
        (singleton, room_id, host_peer_id, host_token_hash, join_token_hash, created_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
      body.roomId,
      body.hostPeerId,
      hostTokenHash,
      joinTokenHash,
      new Date().toISOString(),
    );
    await this.scheduleNextAlarm();

    return jsonResponse(201, { ok: true });
  }

  private async join(
    socket: WebSocket,
    message: Extract<
      NonNullable<ReturnType<typeof parseClientMessage>>,
      { kind: "join" }
    >,
  ): Promise<void> {
    const metadata = this.metadata();
    if (metadata === undefined) {
      this.failAndClose(
        socket,
        "NOT_FOUND",
        "The room no longer exists.",
        4004,
        message.requestId,
      );
      return;
    }

    if (message.roomId !== metadata.room_id) {
      this.failAndClose(
        socket,
        "NOT_FOUND",
        "The join roomId does not match the WebSocket room.",
        4004,
        message.requestId,
      );
      return;
    }

    const suppliedHash = await sha256Base64Url(message.token);
    const expectedHash =
      message.role === "host"
        ? metadata.host_token_hash
        : metadata.join_token_hash;

    if (!timingSafeStringEqual(suppliedHash, expectedHash)) {
      this.failAndClose(
        socket,
        "INVALID_TOKEN",
        "The room token is invalid for the requested role.",
        4003,
        message.requestId,
      );
      return;
    }

    if (message.role === "host" && message.peerId !== metadata.host_peer_id) {
      this.failAndClose(
        socket,
        "HOST_PEER_ID_MISMATCH",
        "The host must use the peer identifier reserved when the room was created.",
        4003,
        message.requestId,
      );
      return;
    }

    if (message.role === "player" && message.peerId === metadata.host_peer_id) {
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
    const duplicate = peers.find(
      ({ attachment }) => attachment.peerId === message.peerId,
    );
    if (duplicate !== undefined) {
      if (message.role === "host" && duplicate.attachment.role === "host") {
        this.markPending(duplicate.socket);
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
      peerId: message.peerId,
      displayName: message.displayName.trim(),
      role: message.role,
      status: "online",
      joinedAt: Date.now(),
    };
    socket.serializeAttachment(joined);
    this.sql.exec(
      `UPDATE room_metadata
       SET empty_expires_at = NULL,
           host_joined_at = CASE
             WHEN ? = 'host' THEN COALESCE(host_joined_at, ?)
             ELSE host_joined_at
           END
       WHERE singleton = 1`,
      message.role,
      new Date(joined.joinedAt).toISOString(),
    );
    await this.scheduleNextAlarm();

    const existingPeers = peers.map(({ attachment }) => publicPeer(attachment));
    this.send(socket, {
      kind: "ready",
      protocolVersion: PROTOCOL_VERSION,
      ok: true,
      roomId: metadata.room_id,
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
    this.markPending(socket);
    this.broadcast(
      {
        kind: "presence",
        protocolVersion: PROTOCOL_VERSION,
        action: "left",
        peer: { peerId: peer.peerId },
      },
      socket,
    );
    if (this.peerSockets().length === 0) {
      this.sql.exec(
        `UPDATE room_metadata
         SET empty_expires_at = ?
         WHERE singleton = 1 AND host_joined_at IS NOT NULL`,
        Date.now() + EMPTY_ROOM_TTL_MS,
      );
    }
  }

  private markPending(socket: WebSocket): void {
    const attachment: SocketAttachment = {
      attachmentVersion: 1,
      authenticated: false,
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

    const metadata = this.metadata();
    if (metadata !== undefined && this.openSockets().length === 0) {
      const roomDeadline = roomExpiryDeadline(metadata);
      if (
        roomDeadline !== undefined &&
        (nextDeadline === undefined || roomDeadline < nextDeadline)
      ) {
        nextDeadline = roomDeadline;
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

  private metadata(): StoredRoomMetadata | undefined {
    return this.sql
      .exec<StoredRoomMetadata>(
        `SELECT room_id, host_peer_id, host_token_hash, join_token_hash,
                created_at, host_joined_at, empty_expires_at
         FROM room_metadata
         WHERE singleton = 1`,
      )
      .toArray()[0];
  }

  private ensureLifecycleColumns(): boolean {
    const columns = new Set(
      this.sql
        .exec<Record<string, SqlStorageValue> & { name: string }>(
          "PRAGMA table_info(room_metadata)",
        )
        .toArray()
        .map(({ name }) => name),
    );
    let changed = false;
    if (!columns.has("host_joined_at")) {
      this.sql.exec("ALTER TABLE room_metadata ADD COLUMN host_joined_at TEXT");
      changed = true;
    }
    if (!columns.has("empty_expires_at")) {
      this.sql.exec(
        "ALTER TABLE room_metadata ADD COLUMN empty_expires_at INTEGER",
      );
      changed = true;
    }
    return changed;
  }

  private reconcileLegacyLifecycle(now: number): void {
    if (this.metadata() === undefined) {
      return;
    }
    const hasOpenSocket = this.openSockets().length > 0;
    this.sql.exec(
      `UPDATE room_metadata
       SET host_joined_at = COALESCE(host_joined_at, created_at),
           empty_expires_at = ?
       WHERE singleton = 1`,
      hasOpenSocket ? null : now + EMPTY_ROOM_TTL_MS,
    );
  }

  private async expireRoomIfEligible(now: number): Promise<boolean> {
    const metadata = this.metadata();
    if (metadata === undefined || this.openSockets().length > 0) {
      return false;
    }
    const deadline = roomExpiryDeadline(metadata);
    if (deadline === undefined || deadline > now) {
      return false;
    }

    this.sql.exec("DELETE FROM room_metadata WHERE singleton = 1");
    await this.ctx.storage.deleteAlarm();
    return true;
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

function readAttachment(socket: WebSocket): SocketAttachment {
  const attachment = socket.deserializeAttachment() as unknown;
  if (
    typeof attachment === "object" &&
    attachment !== null &&
    "attachmentVersion" in attachment &&
    attachment.attachmentVersion === 1 &&
    "authenticated" in attachment
  ) {
    if (attachment.authenticated === true) {
      return attachment as PeerAttachment;
    }
    if (
      attachment.authenticated === false &&
      "authenticationDeadlineAt" in attachment &&
      typeof attachment.authenticationDeadlineAt === "number" &&
      Number.isFinite(attachment.authenticationDeadlineAt)
    ) {
      return attachment as SocketAttachment;
    }
  }

  // Unknown or pre-deadline attachments fail closed on the next event/alarm.
  return {
    attachmentVersion: 1,
    authenticated: false,
    authenticationDeadlineAt: 0,
  };
}

function roomExpiryDeadline(
  metadata: StoredRoomMetadata,
): number | undefined {
  if (metadata.host_joined_at === null) {
    const createdAt = Date.parse(metadata.created_at);
    return Number.isFinite(createdAt)
      ? createdAt + UNCLAIMED_ROOM_TTL_MS
      : 0;
  }
  return metadata.empty_expires_at ?? undefined;
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
