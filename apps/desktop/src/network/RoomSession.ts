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
type CommandOfType<Type extends RoomCommandV1["type"]> = Extract<RoomCommandV1, { type: Type }>;

export interface RoomSessionOptions {
  room: RoomRecord;
  displayName: string;
  relayUrl: string;
  repository: LocalRepository;
  /** Diagnostic switch used by the live forced-relay integration smoke. */
  forceRelay?: boolean;
  /** Override used by deterministic tests; production uses RoomTransport. */
  transportFactory?: RoomSessionTransportFactory;
}

const MAX_ACTIVE_SYNC_TRANSFERS = 2;
const SYNC_TRANSFER_TTL_MS = 2 * 60 * 1_000;
const MAX_SYNC_PAGE_EVENTS = 500;
const MAX_SYNC_PAGE_BYTES = 4 * 1024 * 1024;
const GAP_REPAIR_DEBOUNCE_MS = 25;

interface ActiveSyncTransfer {
  readonly collector: SyncChunkCollector;
  lastUpdatedAt: number;
}

interface PendingHostSync {
  readonly requestId: string;
  readonly pages: readonly (readonly RoomEventV1[])[];
  nextPageIndex: number;
  lastSentPageIndex?: number;
  lastUpdatedAt: number;
}

interface PendingCommandConfirmation {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof globalThis.setTimeout>;
}

export class RoomSession {
  readonly participant: ParticipantV1;
  private readonly transport: RoomSessionTransport;
  private replica: EventReplica;
  private sequencer?: HostEventSequencer;
  private readonly syncCollectors = new Map<string, ActiveSyncTransfer>();
  private readonly participants = new Map<string, ParticipantV1>();
  private readonly pendingCommands = new Map<string, RoomCommandV1>();
  private readonly pendingCommandConfirmations = new Map<string, PendingCommandConfirmation>();
  private readonly pendingHostSyncs = new Map<string, PendingHostSync>();
  private activeSyncRequestId?: string;
  private gapRepairTimer?: ReturnType<typeof globalThis.setTimeout>;
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
      forceRelay: options.forceRelay,
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
        this.requestSync(true);
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
    this.syncCollectors.clear();
    this.pendingHostSyncs.clear();
    this.activeSyncRequestId = undefined;
    if (this.gapRepairTimer !== undefined) globalThis.clearTimeout(this.gapRepairTimer);
    this.gapRepairTimer = undefined;
    for (const [commandId, pending] of this.pendingCommandConfirmations) {
      globalThis.clearTimeout(pending.timer);
      pending.reject(new Error("房间连接已关闭，修改没有获得房主确认"));
      this.pendingCommandConfirmations.delete(commandId);
      this.pendingCommands.delete(commandId);
    }
  }

  async submit<Type extends RoomCommandV1["type"]>(
    type: Type,
    payload: CommandOfType<Type>["payload"],
    commandId = globalThis.crypto.randomUUID(),
  ): Promise<void> {
    if (!this.isHostAvailable) {
      throw new Error("房主当前离线，房间已暂停；房主回来后再继续操作");
    }
    const command = roomCommandSchema.parse({
      protocolVersion: 1,
      roomId: this.options.room.id,
      commandId,
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

  /**
   * Legacy V1 compatibility path for editors that must not clear a local
   * recovery copy until the authoritative event comes back from the host.
   */
  async submitConfirmed<Type extends RoomCommandV1["type"]>(
    type: Type,
    payload: CommandOfType<Type>["payload"],
    commandId = globalThis.crypto.randomUUID(),
    timeoutMs = 30_000,
  ): Promise<void> {
    if (this.isHost) return this.submit(type, payload, commandId);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw new RangeError("命令确认超时必须在 1 到 120 秒之间");
    }
    if (this.pendingCommandConfirmations.has(commandId)) throw new Error("命令 ID 正在等待确认");
    await new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pendingCommandConfirmations.delete(commandId);
        this.pendingCommands.delete(commandId);
        reject(new Error("等待房主确认超时，修改仍保留在本机草稿中"));
      }, timeoutMs);
      this.pendingCommandConfirmations.set(commandId, { resolve, reject, timer });
      void this.submit(type, payload, commandId).catch((cause) => {
        const pending = this.pendingCommandConfirmations.get(commandId);
        if (!pending) return;
        globalThis.clearTimeout(pending.timer);
        this.pendingCommandConfirmations.delete(commandId);
        this.pendingCommands.delete(commandId);
        pending.reject(cause instanceof Error ? cause : new Error(String(cause)));
      });
    });
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
        if (!this.participants.has(fromPeerId)) throw new Error("同步请求来自未认证的房间成员");
        const request = syncRequestSchema.parse({
          protocolVersion: 1,
          type: "sync.request",
          roomId: this.options.room.id,
          requestId: wire.requestId,
          lastSequence: wire.lastSequence,
        });
        const events = await this.options.repository.listEvents(this.options.room.id, request.lastSequence);
        const state: PendingHostSync = {
          requestId: request.requestId,
          pages: paginateSyncEvents(events),
          nextPageIndex: 0,
          lastUpdatedAt: Date.now(),
        };
        this.pendingHostSyncs.set(hostSyncKey(fromPeerId, request.requestId), state);
        this.sendNextSyncPage(fromPeerId, state);
        break;
      }
      case "sync.chunk": {
        if (this.isHost || fromPeerId !== this.options.room.hostPeerId) return;
        const chunk = syncChunkSchema.parse(wire.chunk);
        if (chunk.roomId !== this.options.room.id) throw new Error("同步分块属于其他房间");
        const now = Date.now();
        this.pruneExpiredSyncTransfers(now);
        let transfer = this.syncCollectors.get(chunk.transferId);
        if (transfer === undefined) {
          if (this.syncCollectors.size >= MAX_ACTIVE_SYNC_TRANSFERS) {
            throw new Error("Too many concurrent synchronization transfers");
          }
          transfer = { collector: new SyncChunkCollector(), lastUpdatedAt: now };
          this.syncCollectors.set(chunk.transferId, transfer);
        }
        transfer.lastUpdatedAt = now;
        let events: RoomEventV1[] | undefined;
        try {
          events = transfer.collector.add(chunk);
        } catch (error) {
          this.syncCollectors.delete(chunk.transferId);
          throw error;
        }
        if (events) {
          for (const event of events) await this.acceptEvent(event);
          this.syncCollectors.delete(chunk.transferId);
          this.transport.sendToHost({
            kind: "sync.ack",
            requestId: chunk.requestId,
            transferId: chunk.transferId,
            pageIndex: chunk.pageIndex,
            lastSequence: this.replica.lastContiguousSequence,
          });
          if (chunk.pageIndex + 1 >= chunk.pageCount && this.activeSyncRequestId === chunk.requestId) {
            this.activeSyncRequestId = undefined;
            if (this.replica.missingSequences().length > 0) this.scheduleGapRepair();
          }
        }
        break;
      }
      case "sync.ack": {
        if (!this.isHost) return;
        const key = hostSyncKey(fromPeerId, wire.requestId);
        const state = this.pendingHostSyncs.get(key);
        if (state === undefined || state.lastSentPageIndex !== wire.pageIndex) return;
        state.lastUpdatedAt = Date.now();
        if (state.nextPageIndex >= state.pages.length) {
          this.pendingHostSyncs.delete(key);
        } else {
          this.sendNextSyncPage(fromPeerId, state);
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
      if (event.causedByCommandId) {
        this.pendingCommands.delete(event.causedByCommandId);
        const pending = this.pendingCommandConfirmations.get(event.causedByCommandId);
        if (pending) {
          globalThis.clearTimeout(pending.timer);
          this.pendingCommandConfirmations.delete(event.causedByCommandId);
          pending.resolve();
        }
      }
      if (result.status === "applied") {
        this.onEvents?.(this.replica.orderedEvents());
        if (!this.isHost && this.replica.missingSequences().length > 0) this.scheduleGapRepair();
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

  private pruneExpiredSyncTransfers(now: number): void {
    for (const [transferId, transfer] of this.syncCollectors) {
      if (now - transfer.lastUpdatedAt >= SYNC_TRANSFER_TTL_MS) {
        this.syncCollectors.delete(transferId);
      }
    }
    for (const [key, transfer] of this.pendingHostSyncs) {
      if (now - transfer.lastUpdatedAt >= SYNC_TRANSFER_TTL_MS) {
        this.pendingHostSyncs.delete(key);
      }
    }
  }

  private requestSync(force = false): void {
    if (this.isHost || (!force && this.activeSyncRequestId !== undefined)) return;
    const requestId = globalThis.crypto.randomUUID();
    this.activeSyncRequestId = requestId;
    const sent = this.transport.sendToHost({
      kind: "sync.request",
      requestId,
      lastSequence: this.replica.lastContiguousSequence,
    });
    if (!sent) {
      this.activeSyncRequestId = undefined;
      this.onError?.("中继尚未恢复，暂时无法请求历史补发");
    }
  }

  private scheduleGapRepair(): void {
    if (this.isHost || this.activeSyncRequestId !== undefined || this.gapRepairTimer !== undefined) return;
    this.gapRepairTimer = globalThis.setTimeout(() => {
      this.gapRepairTimer = undefined;
      this.requestSync();
    }, GAP_REPAIR_DEBOUNCE_MS);
  }

  private sendNextSyncPage(peerId: string, state: PendingHostSync): void {
    const pageIndex = state.nextPageIndex;
    const events = state.pages[pageIndex];
    if (events === undefined) return;
    const chunks = createSyncChunks(events, {
      roomId: this.options.room.id,
      requestId: state.requestId,
      pageIndex,
      pageCount: state.pages.length,
    });
    let sent = true;
    for (const chunk of chunks) {
      if (!this.transport.sendToPeer(peerId, { kind: "sync.chunk", chunk })) {
        sent = false;
        break;
      }
    }
    state.lastUpdatedAt = Date.now();
    if (!sent) {
      this.onError?.(`暂时无法向 ${peerId} 发送同步页；对方重连后会重新请求`);
      return;
    }
    state.lastSentPageIndex = pageIndex;
    state.nextPageIndex = pageIndex + 1;
  }
}

function hostSyncKey(peerId: string, requestId: string): string {
  return `${peerId}:${requestId}`;
}

function paginateSyncEvents(events: readonly RoomEventV1[]): readonly (readonly RoomEventV1[])[] {
  const pages: RoomEventV1[][] = [];
  let page: RoomEventV1[] = [];
  let pageBytes = 2;
  for (const event of events) {
    const eventBytes = new TextEncoder().encode(JSON.stringify(event)).byteLength + (page.length === 0 ? 0 : 1);
    if (page.length > 0 && (page.length >= MAX_SYNC_PAGE_EVENTS || pageBytes + eventBytes > MAX_SYNC_PAGE_BYTES)) {
      pages.push(page);
      page = [];
      pageBytes = 2;
    }
    page.push(event);
    pageBytes += eventBytes;
  }
  if (page.length > 0 || pages.length === 0) pages.push(page);
  return pages;
}
