import {
  MAX_RELAY_FRAME_BYTES,
  SAFE_RELAY_FRAME_BYTES,
  RelayFragmentReassembler,
  createRelayFragments,
  peerMessageSchema,
  relayClientEnvelopeSchema,
  relayServerEnvelopeSchema,
  type ParticipantV1,
  type PeerMessageV1,
  type RelayClientEnvelopeV1,
  type RelayServerEnvelopeV1,
  type WebRtcSignalV1,
} from "@coc-room/protocol";

export type ConnectionPath = "connecting" | "direct" | "relay" | "offline";

export type RoomWireMessage = PeerMessageV1;
type SignalData = WebRtcSignalV1;
type ServerMessage = RelayServerEnvelopeV1;

interface PeerLink {
  connection?: RTCPeerConnection;
  channel?: RTCDataChannel;
  pendingCandidates: RTCIceCandidateInit[];
  path: ConnectionPath;
}

export interface RoomTransportOptions {
  roomId: string;
  token: string;
  relayUrl: string;
  participant: ParticipantV1;
  hostPeerId: string;
  iceTimeoutMs?: number;
  /** Diagnostic switch used to verify the complete relay fallback path. */
  forceRelay?: boolean;
}

export class RoomTransport {
  private socket?: WebSocket;
  private readonly links = new Map<string, PeerLink>();
  private readonly relayReassembler = new RelayFragmentReassembler();
  private readonly iceTimeoutMs: number;
  private stopped = false;
  private readonly participants = new Map<string, ParticipantV1>();
  private reconnectTimer?: ReturnType<typeof globalThis.setTimeout>;
  private reconnectAttempts = 0;
  private connecting?: Promise<void>;
  private relayConnected = false;

  onWireMessage?: (fromPeerId: string, message: RoomWireMessage) => void;
  onPresence?: (participants: ParticipantV1[]) => void;
  onPathChange?: (peerId: string, path: ConnectionPath) => void;
  onRelayStateChange?: (connected: boolean) => void;
  onError?: (message: string) => void;

  constructor(private readonly options: RoomTransportOptions) {
    this.iceTimeoutMs = options.iceTimeoutMs ?? 8_000;
  }

  get isHost(): boolean {
    return this.options.participant.role === "host";
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connectSocket();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) globalThis.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.sendSocket({ kind: "leave" });
    this.socket?.close(1000, "client leave");
    this.socket = undefined;
    for (const link of this.links.values()) {
      link.channel?.close();
      link.connection?.close();
    }
    this.links.clear();
    this.relayReassembler.clear();
    this.setRelayConnected(false);
  }

  sendToHost(message: RoomWireMessage): boolean {
    return this.sendToPeer(this.options.hostPeerId, message);
  }

  sendToPeer(peerId: string, message: RoomWireMessage): boolean {
    const link = this.links.get(peerId);
    const serialized = JSON.stringify(message);
    if (link?.channel?.readyState === "open") {
      try {
        link.channel.send(serialized);
        this.setPath(peerId, "direct");
        return true;
      } catch {
        this.setPath(peerId, "relay");
      }
    }
    const sent = this.sendRelay(peerId, message);
    this.setPath(peerId, sent ? "relay" : "offline");
    return sent;
  }

  broadcast(message: RoomWireMessage): void {
    if (!this.isHost) throw new Error("只有房主可以广播房间消息");
    for (const peerId of this.links.keys()) {
      if (!this.sendToPeer(peerId, message)) {
        this.onError?.(`暂时无法向 ${peerId} 发送事件；对方重连后会通过同步补齐`);
      }
    }
  }

  private parseServerMessage(raw: unknown): ServerMessage | undefined {
    if (typeof raw !== "string") return;
    try {
      return relayServerEnvelopeSchema.parse(JSON.parse(raw)) as ServerMessage;
    } catch {
      this.onError?.("中继节点返回了无法解析的消息");
    }
  }

  private handleServerMessage(message: ServerMessage): void {
    switch (message.kind) {
      case "ready":
        this.participants.clear();
        this.participants.set(this.options.participant.peerId, this.options.participant);
        for (const peer of message.peers ?? []) this.participants.set(peer.peerId, peer);
        this.updatePresence([...this.participants.values()]);
        break;
      case "presence":
        if (message.action === "left") this.participants.delete(message.peer.peerId);
        else this.participants.set(message.peer.peerId, message.peer as ParticipantV1);
        this.updatePresence([...this.participants.values()]);
        break;
      case "signal":
        void this.handleSignal(message.fromPeerId, message.data);
        break;
      case "relay":
        if (message.payload.kind === "transport.fragment") {
          try {
            const assembled = this.relayReassembler.add(message.fromPeerId, message.payload);
            if (assembled !== undefined) this.onWireMessage?.(message.fromPeerId, assembled);
          } catch (error) {
            this.onError?.(
              `Unable to reassemble relayed message from ${message.fromPeerId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        } else {
          this.onWireMessage?.(message.fromPeerId, message.payload);
        }
        break;
      case "error":
        this.onError?.(message.message);
        break;
    }
  }

  private updatePresence(participants: ParticipantV1[]): void {
    this.onPresence?.(participants);
    const currentIds = new Set(participants.map((participant) => participant.peerId));
    for (const participant of participants) {
      if (participant.peerId === this.options.participant.peerId) continue;
      if (this.isHost && participant.role === "player") {
        const existing = this.links.get(participant.peerId);
        if (existing?.connection && ["failed", "closed"].includes(existing.connection.connectionState)) {
          existing.connection.close();
          this.links.delete(participant.peerId);
        }
        if (!this.links.has(participant.peerId)) void this.createPeer(participant.peerId, true);
      }
    }
    for (const [peerId, link] of this.links) {
      if (!currentIds.has(peerId)) {
        link.connection?.close();
        this.links.delete(peerId);
        this.onPathChange?.(peerId, "offline");
      }
    }
  }

  private async createPeer(peerId: string, initiator: boolean): Promise<PeerLink> {
    const existing = this.links.get(peerId);
    if (existing) return existing;

    if (this.options.forceRelay) {
      const relayLink: PeerLink = { pendingCandidates: [], path: "relay" };
      this.links.set(peerId, relayLink);
      this.setPath(peerId, "relay");
      return relayLink;
    }

    const connection = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      bundlePolicy: "max-bundle",
    });
    const link: PeerLink = { connection, pendingCandidates: [], path: "connecting" };
    this.links.set(peerId, link);
    this.setPath(peerId, "connecting");

    connection.onicecandidate = ({ candidate }) => {
      if (candidate) {
        if (!this.sendSocket({
          kind: "signal",
          targetPeerId: peerId,
          data: { type: "candidate", candidate: candidate.toJSON() },
        })) this.setPath(peerId, "relay");
      }
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "failed" || connection.connectionState === "disconnected") {
        this.setPath(peerId, "relay");
      }
      if (connection.connectionState === "closed") this.setPath(peerId, "offline");
    };
    connection.ondatachannel = ({ channel }) => this.attachChannel(peerId, link, channel);

    if (initiator) {
      const channel = connection.createDataChannel("coc-room-events", { ordered: true });
      this.attachChannel(peerId, link, channel);
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      if (!this.sendSocket({ kind: "signal", targetPeerId: peerId, data: { type: "offer", description: offer } })) {
        this.setPath(peerId, "relay");
      }
    }

    globalThis.setTimeout(() => {
      if (link.channel?.readyState !== "open" && link.path === "connecting") this.setPath(peerId, "relay");
    }, this.iceTimeoutMs);
    return link;
  }

  private attachChannel(peerId: string, link: PeerLink, channel: RTCDataChannel): void {
    link.channel = channel;
    channel.onopen = () => this.setPath(peerId, "direct");
    channel.onclose = () => this.setPath(peerId, "relay");
    channel.onerror = () => this.setPath(peerId, "relay");
    channel.onmessage = ({ data }) => {
      if (typeof data !== "string") return;
      try {
        this.onWireMessage?.(peerId, peerMessageSchema.parse(JSON.parse(data)));
      } catch {
        this.onError?.(`来自 ${peerId} 的直连消息格式无效`);
      }
    };
  }

  private async handleSignal(fromPeerId: string, signal: SignalData): Promise<void> {
    if (this.options.forceRelay) return;
    try {
      const link = await this.createPeer(fromPeerId, false);
      const connection = link.connection;
      if (connection === undefined) throw new Error("WebRTC connection was not initialized");
      if (signal.type === "offer") {
        await connection.setRemoteDescription(signal.description);
        await this.flushPendingCandidates(link);
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        if (!this.sendSocket({ kind: "signal", targetPeerId: fromPeerId, data: { type: "answer", description: answer } })) {
          this.setPath(fromPeerId, "relay");
        }
      } else if (signal.type === "answer") {
        await connection.setRemoteDescription(signal.description);
        await this.flushPendingCandidates(link);
      } else {
        if (connection.remoteDescription) await connection.addIceCandidate(signal.candidate);
        else link.pendingCandidates.push(signal.candidate);
      }
    } catch (error) {
      this.setPath(fromPeerId, "relay");
      this.onError?.(`直连协商失败，已切换中继：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async flushPendingCandidates(link: PeerLink): Promise<void> {
    const connection = link.connection;
    if (connection === undefined) throw new Error("WebRTC connection was not initialized");
    const pending = link.pendingCandidates.splice(0);
    for (const candidate of pending) await connection.addIceCandidate(candidate);
  }

  private sendRelay(peerId: string, message: RoomWireMessage): boolean {
    const unfragmented = relayClientEnvelopeSchema.parse({
      kind: "relay",
      targetPeerId: peerId,
      payload: message,
    });
    if (frameByteLength(JSON.stringify(unfragmented)) <= SAFE_RELAY_FRAME_BYTES) {
      return this.sendSocket(unfragmented);
    }

    let fragments;
    try {
      fragments = createRelayFragments(message, globalThis.crypto.randomUUID());
    } catch (error) {
      this.onError?.(
        `Unable to split relayed message: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    for (const fragment of fragments) {
      if (!this.sendSocket({ kind: "relay", targetPeerId: peerId, payload: fragment })) {
        return false;
      }
    }
    return true;
  }

  private sendSocket(message: unknown): boolean {
    const envelope = relayClientEnvelopeSchema.parse(message);
    const serialized = JSON.stringify(envelope);
    if (frameByteLength(serialized) > MAX_RELAY_FRAME_BYTES) {
      this.onError?.("WebSocket relay frame exceeds the 64 KiB limit");
      return false;
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(serialized);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  private connectSocket(): Promise<void> {
    if (this.connecting) return this.connecting;
    const request = relayClientEnvelopeSchema.parse({
      kind: "join",
      protocolVersion: 1,
      roomId: this.options.roomId,
      token: this.options.token,
      peerId: this.options.participant.peerId,
      displayName: this.options.participant.displayName,
      role: this.options.participant.role,
      requestId: globalThis.crypto.randomUUID(),
    }) as Extract<RelayClientEnvelopeV1, { kind: "join" }>;

    const attempt = this.openSocket(request);
    this.connecting = attempt;
    void attempt.finally(() => {
      if (this.connecting === attempt) this.connecting = undefined;
    }).catch(() => undefined);
    return attempt;
  }

  private openSocket(request: Extract<RelayClientEnvelopeV1, { kind: "join" }>): Promise<void> {
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.relayUrl);
    } catch (error) {
      return Promise.reject(error);
    }
    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      let authenticated = false;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = globalThis.setTimeout(() => {
        finish(new Error("连接中继节点或验证房间超时"));
        socket.close(4000, "join timeout");
      }, 10_000);

      socket.addEventListener("message", (event) => {
        const message = this.parseServerMessage(event.data);
        if (!message) return;
        if (message.kind === "ready" && message.requestId === request.requestId) {
          if (
            message.roomId !== this.options.roomId ||
            message.self.peerId !== this.options.participant.peerId ||
            message.self.role !== this.options.participant.role
          ) {
            finish(new Error("中继节点返回了不匹配的房间身份"));
            socket.close(4003, "identity mismatch");
            return;
          }
          authenticated = true;
          this.reconnectAttempts = 0;
          this.setRelayConnected(true);
          this.handleServerMessage(message);
          finish();
          return;
        }
        this.handleServerMessage(message);
        if (message.kind === "error" && message.requestId === request.requestId && !authenticated) {
          finish(new Error(message.message));
          socket.close(4003, message.code);
        }
      });
      socket.addEventListener("open", () => {
        try {
          socket.send(JSON.stringify(request));
        } catch {
          finish(new Error("无法向中继节点发送入房验证"));
          socket.close();
        }
      }, { once: true });
      socket.addEventListener("error", () => {
        if (!authenticated) {
          finish(new Error("无法连接中继节点"));
          socket.close();
        }
      });
      socket.addEventListener("close", () => {
        const wasCurrentSocket = this.socket === socket;
        if (wasCurrentSocket) {
          this.socket = undefined;
          this.markRelayUnavailable();
        }
        if (!authenticated) finish(new Error("中继节点在入房验证前关闭了连接"));
        if (!this.stopped && wasCurrentSocket) {
          this.onError?.("中继节点连接已断开；现有直连可继续，正在尝试重连");
          this.scheduleReconnect();
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return;
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempts, 15_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectSocket().catch((error) => {
        this.onError?.(`中继重连失败：${error instanceof Error ? error.message : String(error)}`);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private setPath(peerId: string, path: ConnectionPath): void {
    const link = this.links.get(peerId);
    if (link && link.path === path) return;
    if (link) link.path = path;
    this.onPathChange?.(peerId, path);
  }

  private setRelayConnected(connected: boolean): void {
    if (this.relayConnected === connected) return;
    this.relayConnected = connected;
    this.onRelayStateChange?.(connected);
  }

  private markRelayUnavailable(): void {
    this.setRelayConnected(false);
    const reachablePeerIds = new Set([this.options.participant.peerId]);
    for (const [peerId, link] of [...this.links]) {
      if (link.channel?.readyState === "open") {
        reachablePeerIds.add(peerId);
        this.setPath(peerId, "direct");
        continue;
      }
      this.setPath(peerId, "offline");
      link.connection?.close();
      this.links.delete(peerId);
    }
    for (const peerId of [...this.participants.keys()]) {
      if (!reachablePeerIds.has(peerId)) this.participants.delete(peerId);
    }
    this.onPresence?.([...this.participants.values()]);
  }
}

function frameByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
