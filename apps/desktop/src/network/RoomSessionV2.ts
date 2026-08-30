import {
  EventViewReplicaV2,
  HostEventSequencerV2,
  createRoomCommandV2,
  isAudienceMemberV2,
  projectRoomEventV2,
  roomCommandV2Schema,
  roomEventViewV2Schema,
  roomInvitationPayloadV2Schema,
  type AudienceTargetV2,
  type AudienceV2,
  type AssetDescriptorV1,
  type ParticipantV1,
  type RandomIntSource,
  type RoomCommandV2,
  type RoomEventProposalV2,
  type RoomEventV2,
  type RoomEventViewV2,
  type RoomInvitationPayloadV2,
  type RoomWorldStateV2,
  type SeatV2,
} from "@coc-room/protocol";
import type { LocalRepository, RoomRecord, RoomSeatRecordV2 } from "../data/repository";
import {
  computeSeatProof,
  randomSeatCredential,
  registerHostSeatVerifier,
  verifySeatProof,
} from "../lib/seat-credentials";
import { RoomTransport, type ConnectionPath, type RoomWireMessage } from "./RoomTransport";
import {
  AssetTransferManager,
  type AssetTransferEvent,
  type FinalizeReceivedAssetInput,
  type PersistIncomingAssetChunkInput,
  type RestoredIncomingAssetChunk,
} from "./AssetTransferManager";

const MAX_SYNC_PAGE_EVENTS = 500;
const MAX_SYNC_PAGE_BYTES = 4 * 1024 * 1024;
const AUTH_CHALLENGE_TTL_MS = 30_000;
const ASSET_UPLOAD_LEASE_TTL_MS = 120_000;
const SYNC_PAGE_TIMEOUT_MS = 5_000;
const MAX_SYNC_PAGE_RETRIES = 3;

interface RoomTransportV2Like {
  onWireMessage?: (fromPeerId: string, message: RoomWireMessage) => void;
  onPresence?: (participants: ParticipantV1[]) => void;
  onPathChange?: (peerId: string, path: ConnectionPath) => void;
  onRelayStateChange?: (connected: boolean) => void;
  onError?: (message: string) => void;
  start(): Promise<void>;
  stop(): void;
  sendToHost(message: RoomWireMessage): boolean;
  sendToPeer(peerId: string, message: RoomWireMessage): boolean;
}

export interface RoomSessionV2Options {
  room: RoomRecord;
  displayName: string;
  repository: LocalRepository;
  relayUrl?: string;
  transport?: RoomTransportV2Like;
  clock?: () => Date;
  /** Deterministic test seam; production omits this and uses secure randomness. */
  rng?: RandomIntSource;
  syncPageTimeoutMs?: number;
}

export interface RoomSessionV2AssetAdapter {
  readLocalChunk(input: {
    asset: AssetDescriptorV1;
    offset: number;
    length: number;
  }): Promise<Uint8Array | { bytes: Uint8Array; eof?: boolean }>;
  finalizeReceivedAsset(input: FinalizeReceivedAssetInput): Promise<void>;
  persistIncomingChunk?(input: PersistIncomingAssetChunkInput): Promise<void>;
  hasLocalAsset?(asset: AssetDescriptorV1): Promise<boolean>;
  addEventAssetReference?(input: { asset: AssetDescriptorV1; artifactId: string; revision: number; slot: string }): Promise<void>;
  onEvent?: (event: AssetTransferEvent) => void;
}

interface PendingChallenge {
  seatId: string;
  nonce: string;
  credentialVersion: number;
  expiresAt: number;
}

interface PendingSync {
  requestId: string;
  pages: RoomEventViewV2[][];
  nextPageIndex: number;
  requestedAfter: number;
  retryCount: number;
  timer?: ReturnType<typeof globalThis.setTimeout>;
}

interface PendingCommandConfirmation {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof globalThis.setTimeout>;
}

interface PendingAssetReadiness {
  readonly assetKey: string;
  readonly audience: AudienceV2;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof globalThis.setTimeout>;
}

export class RoomCommandRejectedError extends Error {
  constructor(
    message: string,
    readonly code?: "FORBIDDEN" | "CONFLICT" | "INVALID" | "PAUSED" | "INTERNAL",
  ) {
    super(message);
    this.name = "RoomCommandRejectedError";
  }
}

export type V2AuthenticationState = "waiting" | "challenged" | "authenticated" | "failed";

/**
 * V2 deliberately lives beside RoomSession instead of mutating it. This keeps
 * legacy logs readable while making every network data path seat-authenticated
 * and every player persistence path a full-or-redacted view.
 */
export class RoomSessionV2 {
  readonly room: RoomRecord;
  readonly localSeat: SeatV2;

  private readonly repository: LocalRepository;
  private readonly transport: RoomTransportV2Like;
  private readonly clock: () => Date;
  private readonly rng?: RandomIntSource;
  private readonly syncPageTimeoutMs: number;
  private readonly replica: EventViewReplicaV2;
  private sequencer?: HostEventSequencerV2;
  private seats = new Map<string, RoomSeatRecordV2>();
  private readonly authenticatedByPeer = new Map<string, SeatV2>();
  private readonly peerBySeat = new Map<string, string>();
  private readonly challenges = new Map<string, PendingChallenge>();
  private readonly syncByPeer = new Map<string, PendingSync>();
  private readonly relayParticipants = new Map<string, ParticipantV1>();
  private activeSyncRequest?: { requestId: string; nextPageIndex: number; timer?: ReturnType<typeof globalThis.setTimeout> };
  private recentSyncAck?: { requestId: string; pageIndex: number; lastSequence: number; expiresAt: number };
  private repairTimer?: ReturnType<typeof globalThis.setTimeout>;
  private commandQueue: Promise<void> = Promise.resolve();
  private authenticationState: V2AuthenticationState;
  private assetTransfers?: AssetTransferManager;
  private readonly uploadLeases = new Map<string, { expiresAt: number; descriptors: Map<string, string | undefined> }>();
  private readonly pendingUploadTransfers = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private assetAdapter?: RoomSessionV2AssetAdapter;
  private readonly pendingCommandConfirmations = new Map<string, PendingCommandConfirmation>();
  private readonly readyAssetsBySeat = new Map<string, Set<string>>();
  private readonly assetReadinessWaiters = new Set<PendingAssetReadiness>();
  private stopped = false;

  onViews?: (views: RoomEventViewV2[]) => void;
  onWorld?: (world: RoomWorldStateV2) => void;
  onPresence?: (seats: SeatV2[]) => void;
  onAuthenticationState?: (state: V2AuthenticationState) => void;
  onPathChange?: (peerId: string, path: ConnectionPath) => void;
  onRelayStateChange?: (connected: boolean) => void;
  onPreview?: (fromSeat: SeatV2, preview: Extract<RoomWireMessage, { kind: "board.preview" }>) => void;
  onCommandRejected?: (commandId: string, message: string) => void;
  onUnhandledWireMessage?: (fromSeat: SeatV2, message: RoomWireMessage) => void;
  /** Host only: a seat completed (or re-completed) authentication. */
  onSeatAuthenticated?: (seatId: string) => void;
  onSeatCredentialRotated?: (seatId: string) => void;
  onError?: (message: string) => void;

  constructor(options: RoomSessionV2Options) {
    if ((options.room.protocolVersion ?? 1) !== 2) throw new Error("RoomSessionV2 只能打开 V2 房间");
    if (!options.room.localSeatId || !options.room.hostSeatId) throw new Error("V2 房间缺少稳定席位信息");
    this.room = options.room;
    this.repository = options.repository;
    this.clock = options.clock ?? (() => new Date());
    this.rng = options.rng;
    this.syncPageTimeoutMs = options.syncPageTimeoutMs ?? SYNC_PAGE_TIMEOUT_MS;
    if (!Number.isInteger(this.syncPageTimeoutMs) || this.syncPageTimeoutMs < 10 || this.syncPageTimeoutMs > 60_000) {
      throw new RangeError("同步页超时必须在 10 到 60000 毫秒之间");
    }
    this.localSeat = {
      seatId: options.room.localSeatId,
      role: options.room.localRole,
      displayName: options.displayName.trim(),
      peerId: options.room.localPeerId,
      extensions: {},
    };
    this.replica = new EventViewReplicaV2(options.room.id);
    this.authenticationState = options.room.localRole === "host" ? "authenticated" : "waiting";
    this.transport = options.transport ?? new RoomTransport({
      roomId: options.room.id,
      token: options.room.inviteToken,
      relayUrl: options.relayUrl ?? options.room.relayUrl,
      participant: {
        peerId: options.room.localPeerId,
        displayName: this.localSeat.displayName,
        role: options.room.localRole,
      },
      hostPeerId: options.room.hostPeerId,
    });
  }

  get isHost(): boolean {
    return this.localSeat.role === "host";
  }

  get isAuthenticated(): boolean {
    return this.authenticationState === "authenticated";
  }

  get lastContiguousSequence(): number {
    return this.replica.lastContiguousSequence;
  }

  get world(): RoomWorldStateV2 {
    return this.replica.deriveWorld();
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.repository.saveRoom(this.room);
    const storedViews = await this.repository.listEventViewsV2(this.room.id);
    for (const view of storedViews) this.replica.apply(view);

    if (this.isHost) {
      const authority = await this.repository.listAuthorityEventsV2(this.room.id);
      this.sequencer = new HostEventSequencerV2(this.room.id, {
        initialEvents: authority,
        clock: this.clock,
        ...(this.rng ? { rng: this.rng } : {}),
      });
      this.seats = new Map((await this.repository.listSeatsV2(this.room.id)).map((record) => [record.seat.seatId, record]));
      await this.ensureHostSeat();
      this.authenticatedByPeer.set(this.room.localPeerId, this.localSeat);
      this.peerBySeat.set(this.localSeat.seatId, this.room.localPeerId);
    }

    this.transport.onWireMessage = (fromPeerId, message) => {
      void this.handleWireMessage(fromPeerId, message).catch((error) => this.reportError(error));
    };
    this.transport.onPresence = (participants) => this.handlePresence(participants);
    this.transport.onPathChange = (peerId, path) => this.onPathChange?.(peerId, path);
    this.transport.onRelayStateChange = (connected) => this.handleRelayConnectionState(connected);
    this.transport.onError = (message) => this.onError?.(message);
    this.emitProjection();
    this.setAuthenticationState(this.authenticationState);
    await this.transport.start();
  }

  stop(): void {
    this.stopped = true;
    if (this.repairTimer !== undefined) globalThis.clearTimeout(this.repairTimer);
    this.repairTimer = undefined;
    if (this.activeSyncRequest?.timer) globalThis.clearTimeout(this.activeSyncRequest.timer);
    this.activeSyncRequest = undefined;
    this.recentSyncAck = undefined;
    this.challenges.clear();
    for (const pending of this.syncByPeer.values()) if (pending.timer) globalThis.clearTimeout(pending.timer);
    this.syncByPeer.clear();
    this.assetTransfers?.dispose();
    this.assetTransfers = undefined;
    this.assetAdapter = undefined;
    this.uploadLeases.clear();
    for (const pending of this.pendingUploadTransfers.values()) pending.reject(new Error("房间连接已关闭"));
    this.pendingUploadTransfers.clear();
    for (const [commandId, pending] of this.pendingCommandConfirmations) {
      globalThis.clearTimeout(pending.timer);
      pending.reject(new RoomCommandRejectedError("房间连接已关闭", "PAUSED"));
      this.pendingCommandConfirmations.delete(commandId);
    }
    for (const pending of this.assetReadinessWaiters) {
      globalThis.clearTimeout(pending.timer);
      pending.reject(new Error("房间连接已关闭"));
    }
    this.assetReadinessWaiters.clear();
    this.transport.stop();
  }

  enableAssetTransfers(adapter: RoomSessionV2AssetAdapter): void {
    this.assetAdapter = adapter;
    this.assetTransfers?.dispose();
    this.assetTransfers = new AssetTransferManager({
      sendToPeer: (peerId, message) => this.transport.sendToPeer(peerId, message),
      readLocalChunk: ({ asset, offset, length }) => adapter.readLocalChunk({ asset, offset, length }),
      finalizeReceivedAsset: (input) => adapter.finalizeReceivedAsset(input),
      persistIncomingChunk: adapter.persistIncomingChunk,
      canServeAsset: (peerId, asset, context) => this.canServeAsset(peerId, asset, context.transferId),
      onEvent: (event) => {
        adapter.onEvent?.(event);
        if (this.isHost && event.kind === "completed" && event.direction === "outgoing") {
          const seat = this.authenticatedByPeer.get(event.peerId);
          if (seat) this.markAssetReady(seat.seatId, event.asset);
        }
        const pending = this.pendingUploadTransfers.get(event.transferId);
        if (!pending) return;
        if (event.kind === "completed" && event.direction === "incoming") {
          this.pendingUploadTransfers.delete(event.transferId);
          pending.resolve();
        } else if (event.kind === "error" || event.kind === "cancelled") {
          this.pendingUploadTransfers.delete(event.transferId);
          pending.reject(new Error(event.kind === "error" ? event.message : "资源上传已取消"));
        }
      },
    });
  }

  requestAssetFromHost(asset: AssetDescriptorV1): string {
    if (this.isHost) throw new Error("房主已经是房间资源的来源");
    if (!this.isAuthenticated) throw new Error("席位认证完成前不能请求资源");
    if (!this.assetTransfers) throw new Error("资源传输尚未初始化");
    return this.assetTransfers.requestAsset(this.room.hostPeerId, asset);
  }

  restoreAssetFromHost(
    asset: AssetDescriptorV1,
    transferId: string,
    chunks: readonly RestoredIncomingAssetChunk[],
  ): string {
    if (this.isHost) throw new Error("The host is already the room asset source");
    if (!this.isAuthenticated) throw new Error("Assets cannot resume before seat authentication");
    if (!this.assetTransfers) throw new Error("Asset transfer is not initialized");
    return this.assetTransfers.restoreIncoming(this.room.hostPeerId, asset, transferId, chunks);
  }

  cancelAssetTransfer(transferId: string): boolean {
    if (!this.assetTransfers) return false;
    return this.assetTransfers.cancelTransfer(
      transferId,
      this.isHost ? undefined : this.room.hostPeerId,
    );
  }

  announceAssetReady(asset: AssetDescriptorV1): boolean {
    if (!this.isAuthenticated) return false;
    if (this.isHost) {
      this.markAssetReady(this.localSeat.seatId, asset);
      return true;
    }
    return this.transport.sendToHost({ kind: "asset.ready", asset });
  }

  async waitForAssetReady(
    asset: AssetDescriptorV1,
    audience: AudienceV2,
    timeoutMs = 120_000,
  ): Promise<void> {
    this.requireHost();
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
      throw new RangeError("资源就绪等待时间必须在 1 到 300 秒之间");
    }
    const assetKey = assetDescriptorKey(asset);
    if (this.pendingAssetSeatIds(assetKey, audience).length === 0) return;
    await new Promise<void>((resolve, reject) => {
      const pending: PendingAssetReadiness = {
        assetKey,
        audience,
        resolve: () => {
          globalThis.clearTimeout(pending.timer);
          this.assetReadinessWaiters.delete(pending);
          resolve();
        },
        reject: (error) => {
          globalThis.clearTimeout(pending.timer);
          this.assetReadinessWaiters.delete(pending);
          reject(error);
        },
        timer: globalThis.setTimeout(() => {
          const seats = this.pendingAssetSeatIds(assetKey, audience);
          pending.reject(new Error(`仍有 ${seats.length} 个在线席位未完成音频预取`));
        }, timeoutMs),
      };
      this.assetReadinessWaiters.add(pending);
      this.settleAssetReadinessWaiters();
    });
  }

  async submit(proposal: RoomEventProposalV2, commandId = globalThis.crypto.randomUUID()): Promise<string> {
    if (!this.isAuthenticated) throw new Error("席位认证完成前不能发送房间内容");
    const command = createRoomCommandV2(
      this.room.id,
      this.localSeat,
      proposal,
      commandId,
      this.clock().toISOString(),
    );
    if (!this.isHost) this.createUploadLease(command);
    if (this.isHost) {
      await this.enqueueCommand(command, this.localSeat);
    } else if (!this.transport.sendToHost({ kind: "v2.command", command })) {
      this.uploadLeases.delete(commandId);
      throw new Error("房主当前离线，房间已暂停");
    }
    return commandId;
  }

  /**
   * Submits a command and waits for the host's authoritative ACK. Editors use
   * this narrow path so a revision conflict can open a merge UI instead of
   * clearing the local draft optimistically.
   */
  async submitConfirmed(
    proposal: RoomEventProposalV2,
    commandId = globalThis.crypto.randomUUID(),
    timeoutMs = 30_000,
  ): Promise<string> {
    if (!this.isAuthenticated) throw new Error("席位认证完成前不能发送房间内容");
    if (this.isHost) {
      await this.submit(proposal, commandId);
      return commandId;
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw new RangeError("命令确认超时必须在 1 到 120 秒之间");
    }
    if (this.pendingCommandConfirmations.has(commandId)) throw new Error("命令 ID 正在等待确认");
    const command = createRoomCommandV2(
      this.room.id,
      this.localSeat,
      proposal,
      commandId,
      this.clock().toISOString(),
    );
    this.createUploadLease(command);
    return new Promise<string>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pendingCommandConfirmations.delete(commandId);
        this.uploadLeases.delete(commandId);
        reject(new RoomCommandRejectedError("等待房主确认超时", "PAUSED"));
      }, timeoutMs);
      this.pendingCommandConfirmations.set(commandId, {
        resolve: () => resolve(commandId),
        reject,
        timer,
      });
      if (!this.transport.sendToHost({ kind: "v2.command", command })) {
        globalThis.clearTimeout(timer);
        this.pendingCommandConfirmations.delete(commandId);
        this.uploadLeases.delete(commandId);
        reject(new RoomCommandRejectedError("房主当前离线，房间已暂停", "PAUSED"));
      }
    });
  }

  async rollDice(
    payload: Extract<RoomCommandV2, { type: "dice.roll" }>["payload"],
    audience = { kind: "room" } as const,
    commandId = globalThis.crypto.randomUUID(),
  ): Promise<string> {
    if (!this.isAuthenticated) throw new Error("席位认证完成前不能掷骰");
    const command = roomCommandV2Schema.parse({
      protocolVersion: 2,
      roomId: this.room.id,
      commandId,
      sender: this.localSeat,
      sentAt: this.clock().toISOString(),
      type: "dice.roll",
      audience,
      payload,
    });
    if (this.isHost) await this.enqueueCommand(command, this.localSeat);
    else if (!this.transport.sendToHost({ kind: "v2.command", command })) {
      throw new Error("房主当前离线，房间已暂停");
    }
    return commandId;
  }

  sendPreview(preview: Omit<Extract<RoomWireMessage, { kind: "board.preview" }>, "kind">): boolean {
    if (!this.isAuthenticated) return false;
    const message: Extract<RoomWireMessage, { kind: "board.preview" }> = { kind: "board.preview", ...preview };
    if (this.isHost) {
      this.forwardPreview(this.localSeat, message);
      return true;
    }
    return this.transport.sendToHost(message);
  }

  /**
   * Sends one narrowly-scoped AI draft request to the room host. The host is
   * the only machine allowed to execute providers; this is intentionally not
   * a generic peer-message or Codex proxy API.
   */
  sendAiJobRequest(message: Extract<RoomWireMessage, { kind: "ai.job.request" }>): void {
    if (this.isHost) throw new Error("房主的本地 AI 请求应直接交给房主任务代理");
    if (!this.isAuthenticated) throw new Error("席位认证完成前不能请求 AI 草稿");
    if (!this.transport.sendToHost(message)) throw new Error("房主当前离线，无法处理 AI 草稿");
  }

  /** Sends a job status/result only to the authenticated requesting seat. */
  sendAiJobStatusToSeat(
    seatId: string,
    message: Extract<RoomWireMessage, { kind: "ai.job.status" }>,
  ): boolean {
    this.requireHost();
    const peerId = this.peerBySeat.get(seatId);
    if (!peerId || peerId === this.room.localPeerId) return false;
    return this.transport.sendToPeer(peerId, message);
  }

  async issueSeatInvitation(displayName: string, seatId: string = globalThis.crypto.randomUUID()): Promise<RoomInvitationPayloadV2> {
    this.requireHost();
    if (!this.room.joinToken) throw new Error("房间缺少玩家中继令牌");
    if (this.seats.size >= 8 && !this.seats.has(seatId)) throw new Error("房间最多支持 8 个席位");
    if (this.seats.has(seatId)) throw new Error("席位已经存在；请使用轮换邀请");
    const secret = randomSeatCredential();
    const now = this.clock().toISOString();
    const seat: SeatV2 = { seatId, role: "player", displayName: displayName.trim(), extensions: {} };
    const record: RoomSeatRecordV2 = {
      roomId: this.room.id,
      seat,
      credentialVersion: 1,
      disabled: false,
      createdAt: now,
      updatedAt: now,
    };
    await registerHostSeatVerifier(this.room.id, seatId, secret);
    await this.repository.saveSeatV2(record);
    this.seats.set(seatId, record);
    this.emitPresence();
    return roomInvitationPayloadV2Schema.parse({
      protocolVersion: 2,
      roomId: this.room.id,
      roomName: this.room.name,
      seatId,
      role: "player",
      relayToken: this.room.joinToken,
      seatSecret: secret,
      credentialVersion: 1,
      hostSeatId: this.room.hostSeatId,
      hostPeerId: this.room.hostPeerId,
      relayUrl: this.room.relayUrl,
    });
  }

  async rotateSeatInvitation(seatId: string): Promise<RoomInvitationPayloadV2> {
    this.requireHost();
    if (!this.room.joinToken) throw new Error("房间缺少玩家中继令牌");
    const current = this.seats.get(seatId);
    if (!current || current.seat.role !== "player") throw new Error("找不到可轮换的玩家席位");
    const secret = randomSeatCredential();
    const next: RoomSeatRecordV2 = {
      ...current,
      credentialVersion: current.credentialVersion + 1,
      disabled: false,
      updatedAt: this.clock().toISOString(),
    };
    await registerHostSeatVerifier(this.room.id, seatId, secret);
    await this.repository.saveSeatV2(next);
    this.seats.set(seatId, next);
    const oldPeer = this.peerBySeat.get(seatId);
    if (oldPeer) this.forgetAuthenticatedPeer(oldPeer);
    else this.emitPresence();
    this.onSeatCredentialRotated?.(seatId);
    return roomInvitationPayloadV2Schema.parse({
      protocolVersion: 2,
      roomId: this.room.id,
      roomName: this.room.name,
      seatId,
      role: "player",
      relayToken: this.room.joinToken,
      seatSecret: secret,
      credentialVersion: next.credentialVersion,
      hostSeatId: this.room.hostSeatId,
      hostPeerId: this.room.hostPeerId,
      relayUrl: this.room.relayUrl,
    });
  }

  async disableSeat(seatId: string): Promise<void> {
    this.requireHost();
    const current = this.seats.get(seatId);
    if (!current || current.seat.role !== "player") throw new Error("找不到玩家席位");
    const next = { ...current, disabled: true, updatedAt: this.clock().toISOString() };
    await this.repository.saveSeatV2(next);
    this.seats.set(seatId, next);
    const peerId = this.peerBySeat.get(seatId);
    if (peerId) this.forgetAuthenticatedPeer(peerId);
    else this.emitPresence();
  }

  private async ensureHostSeat(): Promise<void> {
    const current = this.seats.get(this.localSeat.seatId);
    if (current?.seat.role === "player") throw new Error("房主席位与玩家席位冲突");
    const now = this.clock().toISOString();
    const record: RoomSeatRecordV2 = {
      roomId: this.room.id,
      seat: this.localSeat,
      credentialVersion: current?.credentialVersion ?? 1,
      disabled: false,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    await this.repository.saveSeatV2(record);
    this.seats.set(this.localSeat.seatId, record);
  }

  private handlePresence(participants: ParticipantV1[]): void {
    this.relayParticipants.clear();
    for (const participant of participants) this.relayParticipants.set(participant.peerId, participant);
    for (const peerId of [...this.authenticatedByPeer.keys()]) {
      if (peerId !== this.room.localPeerId && !this.relayParticipants.has(peerId)) this.forgetAuthenticatedPeer(peerId);
    }
    for (const peerId of [...this.challenges.keys()]) {
      if (!this.relayParticipants.has(peerId)) this.challenges.delete(peerId);
    }
    if (!this.isHost) {
      if (this.relayParticipants.has(this.room.hostPeerId)) this.sendAuthenticationHello();
      else this.resetPlayerAuthentication();
    }
    this.emitPresence();
  }

  private handleRelayConnectionState(connected: boolean): void {
    if (!connected && !this.stopped) {
      if (this.isHost) {
        for (const peerId of [...this.authenticatedByPeer.keys()]) {
          if (peerId !== this.room.localPeerId) this.forgetAuthenticatedPeer(peerId);
        }
        this.challenges.clear();
        this.syncByPeer.clear();
      } else {
        this.resetPlayerAuthentication();
      }
    }
    this.onRelayStateChange?.(connected);
  }

  private resetPlayerAuthentication(): void {
    if (this.isHost || this.stopped) return;
    this.activeSyncRequest = undefined;
    if (this.repairTimer !== undefined) globalThis.clearTimeout(this.repairTimer);
    this.repairTimer = undefined;
    this.uploadLeases.clear();
    for (const [commandId, pending] of this.pendingCommandConfirmations) {
      globalThis.clearTimeout(pending.timer);
      pending.reject(new RoomCommandRejectedError("房主连接中断，房间已暂停", "PAUSED"));
      this.pendingCommandConfirmations.delete(commandId);
    }
    if (this.authenticationState !== "waiting") this.setAuthenticationState("waiting");
  }

  private sendAuthenticationHello(): void {
    if (
      this.authenticationState === "authenticated" ||
      this.authenticationState === "challenged" ||
      this.stopped
    ) return;
    this.transport.sendToHost({
      kind: "v2.auth.hello",
      protocolVersion: 2,
      seatId: this.localSeat.seatId,
      credentialVersion: this.room.seatCredentialVersion ?? 1,
    });
  }

  private async handleWireMessage(fromPeerId: string, message: RoomWireMessage): Promise<void> {
    if (this.stopped) return;
    if (this.isHost) {
      if (message.kind === "v2.auth.hello") return this.handleAuthHello(fromPeerId, message);
      if (message.kind === "v2.auth.proof") {
        if (this.authenticatedByPeer.has(fromPeerId)) return;
        return this.handleAuthProof(fromPeerId, message);
      }
      const seat = this.authenticatedByPeer.get(fromPeerId);
      if (!seat) return;
      return this.handleAuthenticatedHostMessage(fromPeerId, seat, message);
    }

    if (fromPeerId !== this.room.hostPeerId) return;
    if (message.kind === "v2.auth.challenge") return this.handleAuthChallenge(message);
    if (message.kind === "v2.auth.result") return this.handleAuthResult(message);
    if (!this.isAuthenticated) return;
    return this.handleAuthenticatedPlayerMessage(message);
  }

  private handleAuthHello(
    peerId: string,
    message: Extract<RoomWireMessage, { kind: "v2.auth.hello" }>,
  ): void {
    const record = this.seats.get(message.seatId);
    const relayPeer = this.relayParticipants.get(peerId);
    const occupiedBy = this.peerBySeat.get(message.seatId);
    if (
      !record || record.disabled || record.seat.role !== "player" ||
      record.credentialVersion !== message.credentialVersion ||
      relayPeer?.role !== "player" ||
      (occupiedBy !== undefined && occupiedBy !== peerId)
    ) {
      this.sendAuthenticationFailure(peerId);
      return;
    }
    const existing = this.challenges.get(peerId);
    if (
      existing && existing.expiresAt >= Date.now() &&
      existing.seatId === message.seatId && existing.credentialVersion === message.credentialVersion
    ) {
      this.transport.sendToPeer(peerId, {
        kind: "v2.auth.challenge",
        protocolVersion: 2,
        seatId: existing.seatId,
        nonce: existing.nonce,
      });
      return;
    }
    const nonce = randomSeatCredential(24);
    this.challenges.set(peerId, {
      seatId: message.seatId,
      nonce,
      credentialVersion: message.credentialVersion,
      expiresAt: Date.now() + AUTH_CHALLENGE_TTL_MS,
    });
    this.transport.sendToPeer(peerId, {
      kind: "v2.auth.challenge",
      protocolVersion: 2,
      seatId: message.seatId,
      nonce,
    });
  }

  private async handleAuthChallenge(
    message: Extract<RoomWireMessage, { kind: "v2.auth.challenge" }>,
  ): Promise<void> {
    if (message.seatId !== this.localSeat.seatId || this.isAuthenticated) return;
    this.setAuthenticationState("challenged");
    try {
      const proof = await computeSeatProof(this.room.id, this.localSeat.seatId, message.nonce);
      this.transport.sendToHost({
        kind: "v2.auth.proof",
        protocolVersion: 2,
        seatId: this.localSeat.seatId,
        nonce: message.nonce,
        proof,
      });
    } catch (error) {
      this.setAuthenticationState("failed");
      this.reportError(error);
    }
  }

  private async handleAuthProof(
    peerId: string,
    message: Extract<RoomWireMessage, { kind: "v2.auth.proof" }>,
  ): Promise<void> {
    const pending = this.challenges.get(peerId);
    if (
      !pending || pending.expiresAt < Date.now()
    ) {
      this.challenges.delete(peerId);
      this.sendAuthenticationFailure(peerId);
      return;
    }
    if (pending.seatId !== message.seatId || pending.nonce !== message.nonce) return;
    this.challenges.delete(peerId); // one matching challenge permits exactly one attempt
    const record = this.seats.get(message.seatId);
    if (!record || record.disabled || record.credentialVersion !== pending.credentialVersion) {
      this.sendAuthenticationFailure(peerId);
      return;
    }
    const valid = await verifySeatProof(this.room.id, message.seatId, message.nonce, message.proof);
    if (!valid) {
      this.sendAuthenticationFailure(peerId);
      return;
    }
    const relayPeer = this.relayParticipants.get(peerId);
    const seat: SeatV2 = {
      ...record.seat,
      displayName: record.seat.displayName,
      peerId,
      extensions: {},
    };
    if (!relayPeer || relayPeer.role !== "player") {
      this.sendAuthenticationFailure(peerId);
      return;
    }
    this.authenticatedByPeer.set(peerId, seat);
    this.peerBySeat.set(seat.seatId, peerId);
    const nextRecord = { ...record, seat, updatedAt: this.clock().toISOString() };
    await this.repository.saveSeatV2(nextRecord);
    this.seats.set(seat.seatId, nextRecord);
    this.transport.sendToPeer(peerId, {
      kind: "v2.auth.result",
      protocolVersion: 2,
      ok: true,
      seat,
    });
    this.emitPresence();
    this.onSeatAuthenticated?.(seat.seatId);
  }

  private handleAuthResult(message: Extract<RoomWireMessage, { kind: "v2.auth.result" }>): void {
    if (this.isAuthenticated) return;
    if (!message.ok || !message.seat || message.seat.seatId !== this.localSeat.seatId) {
      this.setAuthenticationState("failed");
      this.onError?.(message.message ?? "席位认证失败；邀请可能已轮换或失效");
      return;
    }
    this.setAuthenticationState("authenticated");
    this.requestSync();
    this.emitPresence();
  }

  private sendAuthenticationFailure(peerId: string): void {
    this.transport.sendToPeer(peerId, {
      kind: "v2.auth.result",
      protocolVersion: 2,
      ok: false,
      message: "席位认证失败；邀请可能已轮换或失效",
    });
  }

  private async handleAuthenticatedHostMessage(peerId: string, seat: SeatV2, message: RoomWireMessage): Promise<void> {
    if (isAssetWireMessage(message)) {
      if (this.assetTransfers) await this.assetTransfers.handleMessage(peerId, message);
      return;
    }
    switch (message.kind) {
      case "v2.command":
        await this.prepareRemoteCommand(message.command, seat, peerId);
        return;
      case "v2.sync.request":
        await this.beginSync(peerId, seat, message.requestId, message.lastSequence);
        return;
      case "v2.sync.ack":
        await this.ackSync(peerId, message);
        return;
      case "board.preview":
        this.forwardPreview(seat, message);
        return;
      case "asset.ready":
        if (await this.repository.hasAssetGrantV2(this.room.id, seat.seatId, message.asset)) {
          this.markAssetReady(seat.seatId, message.asset);
        }
        return;
      default:
        if (isV2DataMessage(message)) this.onUnhandledWireMessage?.(seat, message);
    }
  }

  private async handleAuthenticatedPlayerMessage(message: RoomWireMessage): Promise<void> {
    if (isAssetWireMessage(message)) {
      if (this.assetTransfers) await this.assetTransfers.handleMessage(this.room.hostPeerId, message);
      return;
    }
    switch (message.kind) {
      case "v2.event":
        await this.receiveView(message.view);
        return;
      case "v2.sync.page":
        await this.receiveSyncPage(message);
        return;
      case "v2.command.result":
        this.settleCommandConfirmation(message);
        if (!message.ok) this.onCommandRejected?.(message.commandId, message.message ?? "命令被房主拒绝");
        return;
      case "board.preview": {
        const host = this.hostSeatFromRelay();
        if (host) this.onPreview?.(host, message);
        return;
      }
      default: {
        const host = this.hostSeatFromRelay();
        if (host && isV2DataMessage(message)) this.onUnhandledWireMessage?.(host, message);
      }
    }
  }

  private enqueueCommand(command: RoomCommandV2, seat: SeatV2, peerId?: string): Promise<void> {
    const operation = this.commandQueue.then(() => this.commitCommand(command, seat, peerId));
    this.commandQueue = operation.catch(() => undefined);
    return operation;
  }

  /** Slow uploads run outside the global authority queue after a pure check. */
  private async prepareRemoteCommand(command: RoomCommandV2, seat: SeatV2, peerId: string): Promise<void> {
    try {
      const { duplicate } = this.requireSequencer().preflightCommand(command, seat);
      if (!duplicate) await this.receiveCommandAssets(command, peerId);
    } catch (error) {
      this.transport.sendToPeer(peerId, {
        kind: "v2.command.result",
        protocolVersion: 2,
        commandId: command.commandId,
        ok: false,
        code: classifyCommandError(error),
        message: safeCommandError(error),
      });
      return;
    }
    await this.enqueueCommand(command, seat, peerId);
  }

  private async commitCommand(command: RoomCommandV2, seat: SeatV2, peerId?: string): Promise<void> {
    try {
      const sequencer = this.requireSequencer();
      const { event, duplicate } = sequencer.commitCommand(command, seat);
      if (!duplicate) {
        assertViewFitsSyncPage({ view: "full", event });
        await this.persistEventAssetReferences(event);
        await this.repository.saveAuthorityEventV2(event);
        this.replica.apply({ view: "full", event });
        this.emitProjection();
        // Upgrade the target history before the expansion event itself. A
        // seat must never reduce an expansion against redacted prerequisites.
        if (event.type === "audience.expanded") {
          await this.sendExpandedPayload(event.payload.target);
        }
        for (const [targetPeerId, targetSeat] of this.authenticatedByPeer) {
          if (targetPeerId === this.room.localPeerId) continue;
          const view = projectRoomEventV2(
            event,
            targetSeat,
            sequencer.world.eventAudiences.get(event.eventId),
          );
          await this.persistDeliveredAssetGrants(targetSeat, view);
          this.transport.sendToPeer(targetPeerId, { kind: "v2.event", view });
        }
      }
      if (peerId) {
        this.transport.sendToPeer(peerId, {
          kind: "v2.command.result",
          protocolVersion: 2,
          commandId: command.commandId,
          ok: true,
          eventId: event.eventId,
          sequence: event.sequence,
        });
      }
    } catch (error) {
      await this.rebuildSequencer();
      if (peerId) {
        this.transport.sendToPeer(peerId, {
          kind: "v2.command.result",
          protocolVersion: 2,
          commandId: command.commandId,
          ok: false,
          code: classifyCommandError(error),
          message: safeCommandError(error),
        });
        return;
      }
      throw error;
    }
  }

  private async beginSync(peerId: string, seat: SeatV2, requestId: string, lastSequence: number): Promise<void> {
    const sequencer = this.requireSequencer();
    const boundedSequence = Math.min(lastSequence, sequencer.lastSequence);
    for (const event of sequencer.eventsAfter(0).filter(({ sequence }) => sequence <= boundedSequence)) {
      const view = projectRoomEventV2(
        event,
        seat,
        sequencer.world.eventAudiences.get(event.eventId),
      );
      await this.persistDeliveredAssetGrants(seat, view);
      // A reconnect cursor can already be past an audience expansion. Replay
      // redacted-to-full upgrades independently of the forward-only cursor.
      if (view.view === "full" && !isAudienceMemberV2(event.audience, seat)) {
        this.transport.sendToPeer(peerId, { kind: "v2.event", view });
      }
    }
    const views = sequencer.viewsAfter(seat, boundedSequence);
    const pages = paginateRoomEventViewsV2(views);
    const previous = this.syncByPeer.get(peerId);
    if (previous?.timer) globalThis.clearTimeout(previous.timer);
    this.syncByPeer.set(peerId, { requestId, pages, nextPageIndex: 0, requestedAfter: lastSequence, retryCount: 0 });
    await this.sendCurrentSyncPage(peerId);
  }

  private async sendCurrentSyncPage(peerId: string): Promise<void> {
    const pending = this.syncByPeer.get(peerId);
    if (!pending) return;
    const pageIndex = pending.nextPageIndex;
    const views = pending.pages[pageIndex];
    if (!views) {
      this.syncByPeer.delete(peerId);
      return;
    }
    const seat = this.authenticatedByPeer.get(peerId);
    if (!seat) {
      this.syncByPeer.delete(peerId);
      return;
    }
    for (const view of views) await this.persistDeliveredAssetGrants(seat, view);
    const wire = {
      kind: "v2.sync.page",
      requestId: pending.requestId,
      pageIndex,
      pageCount: pending.pages.length,
      views,
    } as const;
    if (utf8Bytes(JSON.stringify(wire)) > MAX_SYNC_PAGE_BYTES) throw new Error("V2 同步页传输封包超过 4 MiB");
    this.transport.sendToPeer(peerId, wire);
    if (pending.timer) globalThis.clearTimeout(pending.timer);
    pending.timer = globalThis.setTimeout(() => {
      const current = this.syncByPeer.get(peerId);
      if (current !== pending || current.nextPageIndex !== pageIndex) return;
      if (current.retryCount >= MAX_SYNC_PAGE_RETRIES) {
        this.syncByPeer.delete(peerId);
        this.onError?.(`同步页 ${pageIndex} 等待 ACK 超时`);
        return;
      }
      current.retryCount += 1;
      void this.sendCurrentSyncPage(peerId).catch((error) => this.reportError(error));
    }, this.syncPageTimeoutMs);
  }

  private async ackSync(peerId: string, message: Extract<RoomWireMessage, { kind: "v2.sync.ack" }>): Promise<void> {
    const pending = this.syncByPeer.get(peerId);
    if (!pending || pending.requestId !== message.requestId || pending.nextPageIndex !== message.pageIndex) return;
    const page = pending.pages[pending.nextPageIndex] ?? [];
    const expectedLast = page.length === 0
      ? Math.min(pending.requestedAfter, this.requireSequencer().lastSequence)
      : viewSequence(page[page.length - 1]!);
    if (message.lastSequence !== expectedLast) return;
    if (pending.timer) globalThis.clearTimeout(pending.timer);
    pending.timer = undefined;
    pending.retryCount = 0;
    pending.nextPageIndex += 1;
    if (pending.nextPageIndex >= pending.pages.length) this.syncByPeer.delete(peerId);
    else await this.sendCurrentSyncPage(peerId);
  }

  private async receiveSyncPage(message: Extract<RoomWireMessage, { kind: "v2.sync.page" }>): Promise<void> {
    const active = this.activeSyncRequest;
    if (!active || active.requestId !== message.requestId) {
      const recent = this.recentSyncAck;
      if (recent && recent.expiresAt > Date.now() && recent.requestId === message.requestId && recent.pageIndex === message.pageIndex) {
        this.transport.sendToHost({ kind: "v2.sync.ack", requestId: recent.requestId, pageIndex: recent.pageIndex, lastSequence: recent.lastSequence });
      }
      return;
    }
    if (message.pageIndex === active.nextPageIndex - 1) {
      const lastSequence = message.views.length > 0
        ? viewSequence(message.views[message.views.length - 1]!)
        : this.replica.lastContiguousSequence;
      this.transport.sendToHost({ kind: "v2.sync.ack", requestId: message.requestId, pageIndex: message.pageIndex, lastSequence });
      return;
    }
    if (active.nextPageIndex !== message.pageIndex) return;
    if (active.timer) globalThis.clearTimeout(active.timer);
    active.timer = undefined;
    for (const view of message.views) await this.receiveView(view, false);
    const lastSequence = message.views.length > 0
      ? viewSequence(message.views[message.views.length - 1]!)
      : this.replica.lastContiguousSequence;
    this.transport.sendToHost({
      kind: "v2.sync.ack",
      requestId: message.requestId,
      pageIndex: message.pageIndex,
      lastSequence,
    });
    this.recentSyncAck = { requestId: message.requestId, pageIndex: message.pageIndex, lastSequence, expiresAt: Date.now() + this.syncPageTimeoutMs * (MAX_SYNC_PAGE_RETRIES + 1) };
    if (message.pageIndex + 1 >= message.pageCount) {
      this.activeSyncRequest = undefined;
      if (this.replica.missingSequences().length > 0) this.scheduleRepair();
    } else {
      active.nextPageIndex += 1;
      this.armClientSyncTimeout(active);
    }
    this.emitProjection();
  }

  private async receiveView(candidate: RoomEventViewV2, emit = true): Promise<void> {
    const view = roomEventViewV2Schema.parse(candidate);
    await this.repository.saveEventViewV2(view);
    this.replica.apply(view);
    if (emit) this.emitProjection();
    if (this.replica.missingSequences().length > 0) this.scheduleRepair();
  }

  private requestSync(): void {
    if (this.isHost || !this.isAuthenticated || this.activeSyncRequest || this.stopped) return;
    const requestId = globalThis.crypto.randomUUID();
    const active = { requestId, nextPageIndex: 0 };
    this.activeSyncRequest = active;
    if (!this.transport.sendToHost({
      kind: "v2.sync.request",
      requestId,
      lastSequence: this.replica.lastContiguousSequence,
    })) this.activeSyncRequest = undefined;
    else this.armClientSyncTimeout(active);
  }

  private armClientSyncTimeout(active: { requestId: string; nextPageIndex: number; timer?: ReturnType<typeof globalThis.setTimeout> }): void {
    if (active.timer) globalThis.clearTimeout(active.timer);
    active.timer = globalThis.setTimeout(() => {
      if (this.activeSyncRequest !== active) return;
      this.activeSyncRequest = undefined;
      this.requestSync();
    }, this.syncPageTimeoutMs);
  }

  private scheduleRepair(): void {
    if (this.repairTimer !== undefined || this.activeSyncRequest || this.isHost) return;
    this.repairTimer = globalThis.setTimeout(() => {
      this.repairTimer = undefined;
      this.requestSync();
    }, 25);
  }

  private forwardPreview(
    fromSeat: SeatV2,
    message: Extract<RoomWireMessage, { kind: "board.preview" }>,
  ): void {
    const board = this.requireSequencer().world.boards.get(message.boardId);
    if (!board || !isAudienceMemberV2(board.audience, fromSeat)) return;
    this.onPreview?.(fromSeat, message);
    for (const [peerId, seat] of this.authenticatedByPeer) {
      if (peerId === this.room.localPeerId || seat.seatId === fromSeat.seatId) continue;
      if (isAudienceMemberV2(board.audience, seat)) this.transport.sendToPeer(peerId, message);
    }
  }

  /** Sends the newly authorized historical snapshot after an irreversible audience expansion. */
  private async sendExpandedPayload(target: AudienceTargetV2): Promise<void> {
    const sequencer = this.requireSequencer();
    const candidates = sequencer.eventsAfter(0).filter((event) => eventMatchesAudienceTarget(event, target));
    if (candidates.length === 0) return;
    const expandedAudience = audienceForTarget(sequencer.world, target);
    if (!expandedAudience) return;
    for (const [peerId, seat] of this.authenticatedByPeer) {
      if (peerId === this.room.localPeerId) continue;
      if (!isAudienceMemberV2(expandedAudience, seat)) continue;
      for (const event of candidates) {
        const view: RoomEventViewV2 = { view: "full", event };
        await this.persistDeliveredAssetGrants(seat, view);
        this.transport.sendToPeer(peerId, { kind: "v2.event", view });
      }
    }
  }

  private async persistDeliveredAssetGrants(seat: SeatV2, view: RoomEventViewV2): Promise<void> {
    if (view.view !== "full") return;
    const descriptors = assetDescriptorsInEvent(view.event);
    if (descriptors.length === 0) return;
    for (const descriptor of descriptors) {
      await this.repository.saveAssetGrantV2({
        roomId: this.room.id,
        seatId: seat.seatId,
        asset: descriptor,
        grantedSequence: view.event.sequence,
        createdAt: this.clock().toISOString(),
      });
    }
  }

  private async canServeDeliveredAsset(peerId: string, asset: AssetDescriptorV1): Promise<boolean> {
    if (!this.isHost) return false;
    const seat = this.authenticatedByPeer.get(peerId);
    if (!seat) return false;
    return this.repository.hasAssetGrantV2(this.room.id, seat.seatId, asset);
  }

  private async canServeAsset(peerId: string, asset: AssetDescriptorV1, transferId: string): Promise<boolean> {
    if (this.isHost) return this.canServeDeliveredAsset(peerId, asset);
    if (peerId !== this.room.hostPeerId) return false;
    const descriptor = JSON.stringify(asset);
    const now = Date.now();
    for (const [commandId, lease] of this.uploadLeases) {
      if (lease.expiresAt <= now) {
        this.uploadLeases.delete(commandId);
        continue;
      }
      if (!lease.descriptors.has(descriptor)) continue;
      const claimedTransfer = lease.descriptors.get(descriptor);
      if (claimedTransfer !== undefined && claimedTransfer !== transferId) return false;
      lease.descriptors.set(descriptor, transferId);
      return true;
    }
    return false;
  }

  private createUploadLease(command: RoomCommandV2): void {
    const descriptors = assetDescriptorsInCommand(command);
    if (descriptors.length === 0) return;
    this.uploadLeases.set(command.commandId, {
      expiresAt: Date.now() + ASSET_UPLOAD_LEASE_TTL_MS,
      descriptors: new Map(descriptors.map((asset) => [JSON.stringify(asset), undefined])),
    });
  }

  private async receiveCommandAssets(command: RoomCommandV2, peerId: string): Promise<void> {
    const descriptors = assetDescriptorsInCommand(command);
    if (descriptors.length === 0) return;
    if (!this.assetTransfers || !this.assetAdapter?.hasLocalAsset) {
      throw new Error("房主资源传输尚未初始化，不能发布玩家附件");
    }
    for (const asset of descriptors) {
      if (await this.assetAdapter.hasLocalAsset(asset)) continue;
      const transferId = globalThis.crypto.randomUUID();
      const completed = new Promise<void>((resolve, reject) => {
        this.pendingUploadTransfers.set(transferId, { resolve, reject });
      });
      try {
        this.assetTransfers.requestAsset(peerId, asset, transferId);
      } catch (error) {
        this.pendingUploadTransfers.delete(transferId);
        throw error;
      }
      await completed;
      if (!await this.assetAdapter.hasLocalAsset(asset)) throw new Error("玩家附件完成传输后仍未进入房主资源库");
    }
  }

  private async persistEventAssetReferences(event: RoomEventV2): Promise<void> {
    if (event.type !== "artifact.upserted" || !this.assetAdapter?.addEventAssetReference) return;
    const artifact = event.payload.artifact;
    const assets = [...artifact.attachments, ...(artifact.asset ? [artifact.asset] : [])];
    for (const [index, asset] of assets.entries()) {
      await this.assetAdapter.addEventAssetReference({ asset, artifactId: artifact.artifactId, revision: artifact.revision, slot: `event.attachment.${index}` });
    }
  }

  private emitProjection(): void {
    const views = this.replica.orderedViews();
    this.onViews?.(views);
    this.onWorld?.(this.replica.deriveWorld());
  }

  private emitPresence(): void {
    if (this.isHost) {
      const seats = [...this.seats.values()]
        .filter(({ disabled }) => !disabled)
        .map(({ seat }) => {
          // A stored seat may still contain the peer ID from its previous
          // connection. Presence is the live view: preserve the stable seat,
          // but only expose a peer ID while that seat is authenticated now.
          const { peerId: _storedPeerId, ...stableSeat } = seat;
          const peerId = this.peerBySeat.get(seat.seatId);
          return peerId === undefined ? stableSeat : { ...stableSeat, peerId };
        });
      this.onPresence?.(seats);
      return;
    }
    const host = this.hostSeatFromRelay();
    this.onPresence?.(host ? [host, this.localSeat] : [this.localSeat]);
  }

  private hostSeatFromRelay(): SeatV2 | undefined {
    const participant = this.relayParticipants.get(this.room.hostPeerId);
    if (!participant) return;
    return {
      seatId: this.room.hostSeatId!,
      role: "host",
      displayName: participant.displayName,
      peerId: participant.peerId,
      extensions: {},
    };
  }

  private forgetAuthenticatedPeer(peerId: string): void {
    const seat = this.authenticatedByPeer.get(peerId);
    this.authenticatedByPeer.delete(peerId);
    const pendingSync = this.syncByPeer.get(peerId);
    if (pendingSync?.timer) globalThis.clearTimeout(pendingSync.timer);
    this.syncByPeer.delete(peerId);
    this.challenges.delete(peerId);
    if (seat && this.peerBySeat.get(seat.seatId) === peerId) this.peerBySeat.delete(seat.seatId);
    this.settleAssetReadinessWaiters();
    this.emitPresence();
  }

  private markAssetReady(seatId: string, asset: AssetDescriptorV1): void {
    const ready = this.readyAssetsBySeat.get(seatId) ?? new Set<string>();
    ready.add(assetDescriptorKey(asset));
    this.readyAssetsBySeat.set(seatId, ready);
    this.settleAssetReadinessWaiters();
  }

  private pendingAssetSeatIds(assetKey: string, audience: AudienceV2): string[] {
    if (audience.kind === "host") return [];
    const requested = audience.kind === "seats" ? new Set(audience.seatIds) : undefined;
    return [...this.peerBySeat.keys()].filter((seatId) => (
      seatId !== this.localSeat.seatId
      && (requested === undefined || requested.has(seatId))
      && !this.readyAssetsBySeat.get(seatId)?.has(assetKey)
    ));
  }

  private settleAssetReadinessWaiters(): void {
    for (const pending of [...this.assetReadinessWaiters]) {
      if (this.pendingAssetSeatIds(pending.assetKey, pending.audience).length === 0) {
        pending.resolve();
      }
    }
  }

  private setAuthenticationState(state: V2AuthenticationState): void {
    this.authenticationState = state;
    this.onAuthenticationState?.(state);
  }

  private settleCommandConfirmation(
    message: Extract<RoomWireMessage, { kind: "v2.command.result" }>,
  ): void {
    this.uploadLeases.delete(message.commandId);
    const pending = this.pendingCommandConfirmations.get(message.commandId);
    if (!pending) return;
    globalThis.clearTimeout(pending.timer);
    this.pendingCommandConfirmations.delete(message.commandId);
    if (message.ok) pending.resolve();
    else pending.reject(new RoomCommandRejectedError(message.message ?? "命令被房主拒绝", message.code));
  }

  private async rebuildSequencer(): Promise<void> {
    if (!this.isHost) return;
    this.sequencer = new HostEventSequencerV2(this.room.id, {
      initialEvents: await this.repository.listAuthorityEventsV2(this.room.id),
      clock: this.clock,
      ...(this.rng ? { rng: this.rng } : {}),
    });
  }

  private requireHost(): void {
    if (!this.isHost) throw new Error("只有房主可以管理席位邀请");
  }

  private requireSequencer(): HostEventSequencerV2 {
    if (!this.sequencer) throw new Error("V2 房主权威日志尚未初始化");
    return this.sequencer;
  }

  private reportError(error: unknown): void {
    this.onError?.(error instanceof Error ? error.message : String(error));
  }
}

export function paginateRoomEventViewsV2(
  views: readonly RoomEventViewV2[],
  maxEvents = MAX_SYNC_PAGE_EVENTS,
  maxBytes = MAX_SYNC_PAGE_BYTES,
): RoomEventViewV2[][] {
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 500) {
    throw new RangeError("V2 同步页事件数必须在 1 到 500 之间");
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_SYNC_PAGE_BYTES) {
    throw new RangeError("V2 同步页字节上限无效");
  }
  if (views.length === 0) return [[]];
  const pages: RoomEventViewV2[][] = [];
  let current: RoomEventViewV2[] = [];
  for (const candidate of views) {
    const view = roomEventViewV2Schema.parse(candidate);
    const proposed = [...current, view];
    if (current.length >= maxEvents || syncPageEnvelopeBytes(proposed) > maxBytes) {
      if (current.length === 0) throw new Error("单个 V2 事件视图及同步封包超过 4 MiB 上限");
      pages.push(current);
      current = [];
    }
    if (syncPageEnvelopeBytes([...current, view]) > maxBytes) {
      throw new Error("单个 V2 事件视图及同步封包超过 4 MiB 上限");
    }
    current.push(view);
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

function syncPageEnvelopeBytes(views: readonly RoomEventViewV2[]): number {
  return utf8Bytes(JSON.stringify({
    kind: "v2.sync.page",
    requestId: "00000000-0000-4000-8000-000000000000",
    pageIndex: 99_999,
    pageCount: 100_000,
    views,
  }));
}

function assertViewFitsSyncPage(view: RoomEventViewV2): void {
  paginateRoomEventViewsV2([view]);
}

function viewSequence(view: RoomEventViewV2): number {
  return view.view === "full" ? view.event.sequence : view.sequence;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isV2DataMessage(message: RoomWireMessage): boolean {
  return message.kind.startsWith("asset.") || message.kind.startsWith("ai.job.");
}

function isAssetWireMessage(message: RoomWireMessage): boolean {
  return message.kind === "asset.request" || message.kind === "asset.chunk"
    || message.kind === "asset.ack" || message.kind === "asset.cancel"
    || message.kind === "asset.error";
}

function assetDescriptorKey(asset: AssetDescriptorV1): string {
  return JSON.stringify([
    asset.assetId,
    asset.mediaType,
    asset.byteLength,
    asset.width ?? null,
    asset.height ?? null,
    asset.durationMs ?? null,
  ]);
}

function assetDescriptorsInEvent(event: RoomEventV2): AssetDescriptorV1[] {
  switch (event.type) {
    case "artifact.upserted":
      return [
        ...event.payload.artifact.attachments,
        ...(event.payload.artifact.asset ? [event.payload.artifact.asset] : []),
      ];
    case "audio.cued":
      return [event.payload.asset];
    default:
      return [];
  }
}

function assetDescriptorsInCommand(command: RoomCommandV2): AssetDescriptorV1[] {
  if (command.type !== "event.submit") return [];
  // `roomCommandV2Schema` has already validated this payload; Zod's mapped
  // proposal inference loses the discriminated-union correlation at this edge.
  return assetDescriptorsInProposal(command.proposal as RoomEventProposalV2);
}

function assetDescriptorsInProposal(proposal: RoomEventProposalV2): AssetDescriptorV1[] {
  if (proposal.type !== "artifact.upserted") return [];
  const artifact = proposal.payload.artifact;
  const values = [...artifact.attachments, ...(artifact.asset ? [artifact.asset] : [])];
  const unique = new Map(values.map((asset) => [JSON.stringify(asset), asset]));
  return [...unique.values()];
}

function eventMatchesAudienceTarget(event: RoomEventV2, target: AudienceTargetV2): boolean {
  switch (target.kind) {
    case "event": return event.eventId === target.eventId;
    case "entity": return (
      (event.type === "entity.upserted" && event.payload.entity.entityId === target.entityId)
      || (event.type === "scene.focused" && event.payload.sceneEntityId === target.entityId)
    );
    case "artifact": return event.type === "artifact.upserted" && event.payload.artifact.artifactId === target.artifactId;
    case "board": return (event.type === "board.created" || event.type === "board.updated") && event.payload.board.boardId === target.boardId;
    case "board-item": return event.type === "board.item.upserted" && event.payload.boardId === target.boardId && event.payload.item.itemId === target.itemId;
    case "board-edge": return event.type === "board.edge.upserted" && event.payload.boardId === target.boardId && event.payload.edge.edgeId === target.edgeId;
    case "fog-mask": return event.type === "board.fog.revealed" && event.payload.boardId === target.boardId;
    case "npc-session": return event.type === "npc.session.upserted" && event.payload.session.sessionId === target.sessionId;
  }
}

function audienceForTarget(world: RoomWorldStateV2, target: AudienceTargetV2) {
  switch (target.kind) {
    case "event": return world.eventAudiences.get(target.eventId);
    case "entity": return world.entities.get(target.entityId)?.audience;
    case "artifact": return world.artifacts.get(target.artifactId)?.audience;
    case "board": return world.boards.get(target.boardId)?.audience;
    case "board-item": return world.boards.get(target.boardId)?.items.find(({ itemId }) => itemId === target.itemId)?.audience;
    case "board-edge": return world.boards.get(target.boardId)?.edges.find(({ edgeId }) => edgeId === target.edgeId)?.audience;
    case "fog-mask": return world.boards.get(target.boardId)?.fogMask?.audience;
    case "npc-session": return world.npcSessions.get(target.sessionId)?.audience;
  }
}

function safeCommandError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1_000);
}

function classifyCommandError(error: unknown): "FORBIDDEN" | "CONFLICT" | "INVALID" | "INTERNAL" {
  const message = error instanceof Error ? error.message : String(error);
  if (/only the host|cannot submit|cannot see|visible|locked|own character/i.test(message)) return "FORBIDDEN";
  if (/revision|conflict|already|sequence|duplicate/i.test(message)) return "CONFLICT";
  if (/invalid|parse|required|exceed|must/i.test(message)) return "INVALID";
  return "INTERNAL";
}
