import {
  EventReplica,
  HostEventSequencer,
  SyncChunkCollector,
  createSyncChunks,
  participantSchema,
  roomCommandSchema,
  roomEventSchema,
  syncChunkSchema,
  syncRequestSchema,
  type ParticipantV1,
  type RoomCommandV1,
  type RoomEventV1,
} from "@coc-room/protocol";
import type { LocalRepository, RoomRecord } from "../data/repository";
import {
  RoomTransport,
  type ConnectionPath,
  type RoomTransportOptions,
  type RoomWireMessage,
} from "./RoomTransport";

export interface RoomSessionTransport {
  onWireMessage?: (fromPeerId: string, message: RoomWireMessage) => void | Promise<void>;
  onPresence?: (participants: ParticipantV1[]) => void;
  onPathChange?: (peerId: string, path: ConnectionPath) => void;
  onRelayStateChange?: (connected: boolean) => void;
  onError?: (message: string) => void;
  start(): Promise<void>;
  stop(): void;
  sendToHost(message: RoomWireMessage): boolean;
  sendToPeer(peerId: string, message: RoomWireMessage): boolean;
  broadcast(message: RoomWireMessage): void;
}

export type RoomSessionTransportFactory = (options: RoomTransportOptions) => RoomSessionTransport;

export interface RoomSessionOptions {
  room: RoomRecord;
  displayName: string;
  relayUrl: string;
  repository: LocalRepository;
  /** Override used by deterministic tests; production uses RoomTransport. */
  transportFactory?: RoomSessionTransportFactory;
}

export class RoomSession {
  readonly participant: ParticipantV1;
  private readonly transport: RoomSessionTransport;
  private replica: EventReplica;
  private sequencer?: HostEventSequencer;
  private readonly syncCollectors = new Map<string, SyncChunkCollector>();
  private readonly participants = new Map<string, ParticipantV1>();
  private readonly pendingCommands = new Map<string, RoomCommandV1>();
  private hostPath?: ConnectionPath;
  private commandCommitTail: Promise<void> = Promise.resolve();

  onEvents?: (events: RoomEventV1[]) => void;
  onPresence?: (participants: ParticipantV1[]) => void;
  onPathChange?: (peerId: string, path: ConnectionPath) => void;
  onRelayStateChange?: (connected: boolean) => void;
  onError?: (message: string) => void;

  constructor(private readonly options: RoomSessionOptions) {
    this.participant = {
      peerId: options.room.localPeerId,
      displayName: options.displayName,
      role: options.room.localRole,
    };
    this.replica = new EventReplica(options.room.id);
    this.participants.set(this.participant.peerId, this.participant);
    const createTransport = options.transportFactory ?? ((transportOptions) => new RoomTransport(transportOptions));
    this.transport = createTransport({
      roomId: options.room.id,
      token: options.room.inviteToken,
      relayUrl: options.relayUrl,
      participant: this.participant,
      hostPeerId: options.room.hostPeerId,
    });
    this.transport.onWireMessage = async (peerId, message) => {
      try {
        await this.handleWireMessage(peerId, message);
      } catch (error) {
        this.onError?.(error instanceof Error ? error.message : String(error));
      }
    };
    this.transport.onPresence = (participants) => {
      const canonicalParticipants = participants.map((participant) => participantSchema.parse({
        peerId: participant.peerId,
        displayName: participant.displayName,
        role: participant.role,
      }));
      this.participants.clear();
      for (const participant of canonicalParticipants) this.participants.set(participant.peerId, participant);
      if (canonicalParticipants.some((peer) => peer.peerId === options.room.hostPeerId && peer.role === "host")) {
        // A fresh authenticated presence snapshot proves the relay can see the
        // host again, even if the previous send marked the route offline.
        this.hostPath = undefined;
      }
      this.onPresence?.(canonicalParticipants);
      if (!this.isHost && canonicalParticipants.some((peer) => peer.peerId === options.room.hostPeerId)) {
        const syncSent = this.transport.sendToHost({
          kind: "sync.request",
          requestId: globalThis.crypto.randomUUID(),
          lastSequence: this.replica.lastContiguousSequence,
        });
        if (!syncSent) this.onError?.("中继尚未恢复，暂时无法请求历史补发");
        this.resendPendingCommands();
      }
    };
    this.transport.onPathChange = (peerId, path) => {
      if (peerId === options.room.hostPeerId) this.hostPath = path;
      this.onPathChange?.(peerId, path);
    };
    this.transport.onRelayStateChange = (connected) => this.onRelayStateChange?.(connected);
    this.transport.onError = (message) => this.onError?.(message);
  }

  get isHost(): boolean {
    return this.participant.role === "host";
  }

  get isHostAvailable(): boolean {
    if (this.isHost) return true;
    const host = this.participants.get(this.options.room.hostPeerId);
    return host?.role === "host" && this.hostPath !== "offline";
  }

  async start(): Promise<void> {
    // A transport may deliver presence and sync chunks as part of start(). Persist the
    // room first so SQLite's room_events -> rooms foreign key is always satisfied.
    await this.options.repository.saveRoom(this.options.room);
    await this.reloadFromRepository();
    await this.transport.start();
  }

  stop(): void {
    this.transport.stop();
  }

  async submit(type: RoomCommandV1["type"], payload: RoomCommandV1["payload"]): Promise<void> {
    if (!this.isHostAvailable) {
      throw new Error("房主当前离线，房间已暂停；房主回来后再继续操作");
    }
    const command = roomCommandSchema.parse({
      protocolVersion: 1,
      roomId: this.options.room.id,
      commandId: globalThis.crypto.randomUUID(),
      sender: this.participant,
      sentAt: new Date().toISOString(),
      type,
      payload,
    });
    if (this.isHost) {
      await this.commitCommand(command, this.participant);
      return;
    }
    this.pendingCommands.set(command.commandId, command);
    if (!this.transport.sendToHost({ kind: "command", command })) {
      this.onError?.("命令已暂存在本次会话中，将在重连房主后重发");
    }
  }

  private async handleWireMessage(fromPeerId: string, wire: RoomWireMessage): Promise<void> {
    switch (wire.kind) {
      case "command": {
        if (!this.isHost) return;
        const command = roomCommandSchema.parse(wire.command);
        if (command.sender.peerId !== fromPeerId) throw new Error("命令发送者与连接身份不一致");
        const authenticated = this.participants.get(fromPeerId);
        if (!authenticated) throw new Error("发送命令的成员不在在线名单中");
        const trustedCommand = roomCommandSchema.parse({ ...command, sender: authenticated });
        await this.commitCommand(trustedCommand, authenticated, fromPeerId);
        break;
      }
      case "event": {
        if (this.isHost || fromPeerId !== this.options.room.hostPeerId) return;
        await this.acceptEvent(roomEventSchema.parse(wire.event));
        break;
      }
      case "sync.request": {
        if (!this.isHost) return;
        const request = syncRequestSchema.parse({
          protocolVersion: 1,
          type: "sync.request",
          roomId: this.options.room.id,
          requestId: wire.requestId,
          lastSequence: wire.lastSequence,
        });
        const events = await this.options.repository.listEvents(this.options.room.id, request.lastSequence);
        const chunks = createSyncChunks(events, {
          roomId: this.options.room.id,
          requestId: request.requestId,
        });
        for (const chunk of chunks) this.transport.sendToPeer(fromPeerId, { kind: "sync.chunk", chunk });
        break;
      }
      case "sync.chunk": {
        if (this.isHost || fromPeerId !== this.options.room.hostPeerId) return;
        const chunk = syncChunkSchema.parse(wire.chunk);
        if (chunk.roomId !== this.options.room.id) throw new Error("同步分块属于其他房间");
        const collector = this.syncCollectors.get(chunk.transferId) ?? new SyncChunkCollector();
        this.syncCollectors.set(chunk.transferId, collector);
        const events = collector.add(chunk);
        if (events) {
          for (const event of events) await this.acceptEvent(event);
          this.syncCollectors.delete(chunk.transferId);
        }
        break;
      }
    }
  }

  private async commitCommand(
    command: RoomCommandV1,
    expectedSender: ParticipantV1,
    replyPeerId?: string,
  ): Promise<void> {
    const commit = this.commandCommitTail.then(() => this.commitCommandNow(command, expectedSender, replyPeerId));
    this.commandCommitTail = commit.catch(() => undefined);
    return commit;
  }

  private async commitCommandNow(
    command: RoomCommandV1,
    expectedSender: ParticipantV1,
    replyPeerId?: string,
  ): Promise<void> {
    if (!this.sequencer) throw new Error("房主事件序列尚未初始化");
    const { event, duplicate } = this.sequencer.commitCommand(command, { expectedSender });
    if (duplicate) {
      if (replyPeerId && !this.transport.sendToPeer(replyPeerId, { kind: "event", event })) {
        this.onError?.(`无法重发命令 ${command.commandId} 的既有回执`);
      }
      return;
    }
    await this.acceptEvent(event);
    this.transport.broadcast({ kind: "event", event });
  }

  private async acceptEvent(event: RoomEventV1): Promise<void> {
    try {
      await this.options.repository.saveEvent(event);
      const result = this.replica.apply(event);
      if (event.causedByCommandId) this.pendingCommands.delete(event.causedByCommandId);
      if (result.status === "applied") {
        this.onEvents?.(this.replica.orderedEvents());
      }
    } catch (error) {
      try {
        await this.reloadFromRepository();
      } catch (reloadError) {
        this.onError?.(`事件持久化失败，且无法重载本地日志：${reloadError instanceof Error ? reloadError.message : String(reloadError)}`);
      }
      throw error;
    }
  }

  private async reloadFromRepository(): Promise<void> {
    const history = await this.options.repository.listEvents(this.options.room.id);
    const replica = new EventReplica(this.options.room.id);
    for (const event of history) replica.apply(event);
    this.replica = replica;
    this.sequencer = this.isHost
      ? new HostEventSequencer(this.options.room.id, { initialEvents: history })
      : undefined;
    for (const event of history) {
      if (event.causedByCommandId) this.pendingCommands.delete(event.causedByCommandId);
    }
    this.onEvents?.(this.replica.orderedEvents());
  }

  private resendPendingCommands(): void {
    for (const command of this.pendingCommands.values()) {
      if (!this.transport.sendToHost({ kind: "command", command })) {
        this.onError?.("中继尚未可用，未确认命令会继续保留到下次重连");
        return;
      }
    }
  }
}
