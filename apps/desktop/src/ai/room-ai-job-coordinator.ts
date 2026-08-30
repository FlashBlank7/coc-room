import {
  coc7CharacterSchema,
  type Coc7Character,
  type SeatV2,
} from "@coc-room/protocol";
import type { RoomSessionV2 } from "../network/RoomSessionV2";
import type { RoomWireMessage } from "../network/RoomTransport";

type AiJobRequest = Extract<RoomWireMessage, { kind: "ai.job.request" }>;
type AiJobStatus = Extract<RoomWireMessage, { kind: "ai.job.status" }>;

export interface CharacterDraftExecutionRequest {
  jobId: string;
  task: "character-draft";
  provider: "deepseek" | "codex";
  model: string;
  prompt: string;
  playerName: string;
  ownerSeatId: string;
}

export interface RoomAiDraftExecutor {
  executeCharacterDraft(
    request: CharacterDraftExecutionRequest,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface RoomAiJobCoordinatorOptions {
  session: RoomSessionV2;
  executor?: RoomAiDraftExecutor;
  provider: "deepseek" | "codex";
  model: string;
  maxConcurrent?: number;
  maxQueued?: number;
  timeoutMs?: number;
  onHostStatus?(seat: SeatV2, status: AiJobStatus): void;
  onClientStatus?(status: AiJobStatus): void;
}

interface QueuedJob {
  request: AiJobRequest;
  requester: SeatV2;
}

interface PendingClientRequest {
  request: AiJobRequest;
  resolve(character: Coc7Character): void;
  reject(error: Error): void;
  timer: ReturnType<typeof globalThis.setTimeout>;
  awaitingReview: boolean;
}

interface HeldReview {
  requester: SeatV2;
  terminal: AiJobStatus;
}

const MAX_PROMPT_CODE_POINTS = 100_000;
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Host-controlled broker for room AI drafts. Remote peers can request the
 * fixed `character-draft` operation only; provider/model selection and the
 * actual executor always stay on the host. Remote results are held for KP
 * review and only released to the requesting player via approveDraft.
 */
export class RoomAiJobCoordinator {
  private readonly session: RoomSessionV2;
  private readonly executor?: RoomAiDraftExecutor;
  private readonly provider: "deepseek" | "codex";
  private readonly model: string;
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly timeoutMs: number;
  private readonly onHostStatus?: (seat: SeatV2, status: AiJobStatus) => void;
  private readonly onClientStatus?: (status: AiJobStatus) => void;
  private readonly queue: QueuedJob[] = [];
  private readonly running = new Map<string, AbortController>();
  /** jobId → requesting seatId; also the idempotency ledger for replays. */
  private readonly seenJobIds = new Map<string, string>();
  private readonly pendingClients = new Map<string, PendingClientRequest>();
  private readonly pendingReview = new Map<string, HeldReview>();
  private readonly terminalByJobId = new Map<string, AiJobStatus>();
  private readonly outbox = new Map<string, AiJobStatus[]>();
  private disposed = false;

  constructor(options: RoomAiJobCoordinatorOptions) {
    this.session = options.session;
    this.executor = options.executor;
    this.provider = options.provider;
    this.model = options.model.trim();
    this.maxConcurrent = clampInteger(options.maxConcurrent ?? 4, 1, 64);
    this.maxQueued = clampInteger(options.maxQueued ?? 64, 1, 1024);
    this.timeoutMs = clampInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, 60 * 60_000);
    this.onHostStatus = options.onHostStatus;
    this.onClientStatus = options.onClientStatus;
  }

  async requestCharacterDraft(prompt: string, playerName: string): Promise<Coc7Character> {
    if (this.disposed) return Promise.reject(new Error("房间 AI 草稿代理已经关闭"));
    const normalizedPrompt = validatePrompt(prompt);
    const normalizedPlayerName = validatePlayerName(playerName);
    const jobId = globalThis.crypto.randomUUID();
    const request: AiJobRequest = {
      kind: "ai.job.request",
      jobId,
      task: "character-draft",
      // These wire values are informational only. The host replaces them with
      // its own configured provider and model before invoking an executor.
      provider: this.provider,
      model: this.model,
      input: { prompt: normalizedPrompt, playerName: normalizedPlayerName },
    };

    const promise = new Promise<Coc7Character>((resolve, reject) => {
      this.pendingClients.set(jobId, {
        request,
        resolve,
        reject,
        timer: this.armClientTimer(jobId),
        awaitingReview: false,
      });
    });

    if (this.session.isHost) {
      this.acceptHostRequest(this.session.localSeat, request);
    } else {
      try {
        this.session.sendAiJobRequest(request);
      } catch (error) {
        this.rejectPending(jobId, toError(error));
      }
    }
    return promise;
  }

  /** Multiplex this from RoomSessionV2.onUnhandledWireMessage. */
  handleWireMessage(fromSeat: SeatV2, message: RoomWireMessage): boolean {
    if (message.kind === "ai.job.request") {
      if (!this.session.isHost) return true;
      this.acceptHostRequest(fromSeat, message);
      return true;
    }
    if (message.kind === "ai.job.status") {
      if (this.session.isHost) return true;
      this.acceptClientStatus(message);
      return true;
    }
    return false;
  }

  /** Releases a KP-reviewed draft to the requesting player. */
  approveDraft(jobId: string): boolean {
    const held = this.pendingReview.get(jobId);
    if (!held) return false;
    this.pendingReview.delete(jobId);
    this.dispatchToRequester(held.requester, held.terminal);
    return true;
  }

  /** Returns a KP-reviewed draft to the requesting player as rejected. */
  rejectDraft(jobId: string, reason?: string): boolean {
    const held = this.pendingReview.get(jobId);
    if (!held) return false;
    this.pendingReview.delete(jobId);
    const detail = reason?.trim();
    this.dispatchToRequester(held.requester, status(
      jobId,
      "cancelled",
      detail ? `KP 退回了这份草稿：${detail}` : "KP 退回了这份草稿",
    ));
    return true;
  }

  /** Re-sends statuses that could not reach a seat while it was offline. */
  flushOutbox(seatId?: string): void {
    if (this.disposed) return;
    for (const seat of seatId === undefined ? [...this.outbox.keys()] : [seatId]) {
      const parked = this.outbox.get(seat);
      if (!parked?.length) continue;
      const remaining = parked.filter((message) => !this.session.sendAiJobStatusToSeat(seat, message));
      if (remaining.length === 0) this.outbox.delete(seat);
      else this.outbox.set(seat, remaining);
    }
  }

  /** Player-side recovery: re-request unfinished jobs after re-authentication. */
  resendPendingRequests(): void {
    if (this.disposed || this.session.isHost) return;
    for (const pending of this.pendingClients.values()) {
      try {
        this.session.sendAiJobRequest(pending.request);
      } catch {
        // Host still offline; the client timer keeps bounding the wait.
      }
    }
  }

  shutdown(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.splice(0);
    for (const controller of this.running.values()) controller.abort(new Error("房间 AI 草稿代理已经关闭"));
    this.running.clear();
    // Held reviews live only in this host's memory; tell waiting players the
    // truth instead of letting their spinners run into a misleading timeout.
    for (const [jobId, held] of this.pendingReview) {
      try {
        this.session.sendAiJobStatusToSeat(held.requester.seatId, status(
          jobId,
          "cancelled",
          "KP 已离开房间，这份草稿失效了；KP 回来后可以重新申请",
        ));
      } catch {
        // The session is going down with us; nothing more to do.
      }
    }
    this.pendingReview.clear();
    this.outbox.clear();
    for (const [jobId] of this.pendingClients) this.rejectPending(jobId, new Error("房间 AI 草稿代理已经关闭"));
  }

  /**
   * Drops every artifact tied to a seat whose credentials were rotated: parked
   * statuses and held drafts must never reach the invitation's next holder.
   */
  forgetSeat(seatId: string): void {
    this.outbox.delete(seatId);
    for (const [jobId, held] of [...this.pendingReview]) {
      if (held.requester.seatId === seatId) this.pendingReview.delete(jobId);
    }
    for (const [jobId, ownerSeatId] of [...this.seenJobIds]) {
      if (ownerSeatId === seatId) {
        this.seenJobIds.delete(jobId);
        this.terminalByJobId.delete(jobId);
      }
    }
  }

  private acceptHostRequest(requester: SeatV2, request: AiJobRequest): void {
    if (this.disposed) return;
    this.flushOutbox(requester.seatId);
    const ownerSeatId = this.seenJobIds.get(request.jobId);
    if (ownerSeatId !== undefined) {
      // Idempotent replay (player reconnected): re-send the current state to
      // the original requester only; never leak results to another seat.
      if (ownerSeatId !== requester.seatId) return;
      if (this.pendingReview.has(request.jobId)) {
        this.sendToSeatOrPark(requester.seatId, reviewNotice(request.jobId));
        return;
      }
      const terminal = this.terminalByJobId.get(request.jobId);
      if (terminal) {
        this.sendToSeatOrPark(requester.seatId, terminal);
        return;
      }
      this.sendToSeatOrPark(requester.seatId, status(request.jobId, "running", "角色草稿仍在处理中"));
      return;
    }
    this.seenJobIds.set(request.jobId, requester.seatId);

    try {
      if (request.task !== "character-draft") {
        throw new Error("玩家只能请求角色卡草稿；NPC 与模组任务由 KP 工作台发起");
      }
      // Deliberately accept only these two scalar fields from the untrusted
      // JSON record. No path, command, tool, URL, schema, or environment field
      // can reach the provider executor.
      const prompt = validatePrompt(request.input.prompt);
      const playerName = validatePlayerName(request.input.playerName ?? requester.displayName);
      if (this.queue.length + this.running.size >= this.maxQueued + this.maxConcurrent) {
        throw new Error("房主 AI 队列已满，请稍后重试");
      }
      const sanitized: AiJobRequest = {
        kind: "ai.job.request",
        jobId: request.jobId,
        task: "character-draft",
        provider: this.provider,
        model: this.model,
        input: { prompt, playerName },
      };
      this.queue.push({ request: sanitized, requester });
      this.deliver(requester, status(request.jobId, "queued", "角色草稿已进入房主队列"));
      this.drain();
    } catch (error) {
      this.deliver(requester, status(request.jobId, "failed", toError(error).message));
    }
  }

  private drain(): void {
    while (!this.disposed && this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift()!;
      const controller = new AbortController();
      this.running.set(job.request.jobId, controller);
      void this.run(job, controller).finally(() => {
        this.running.delete(job.request.jobId);
        this.drain();
      });
    }
  }

  private async run(job: QueuedJob, controller: AbortController): Promise<void> {
    const { request, requester } = job;
    if (!this.executor) {
      this.deliver(requester, status(request.jobId, "failed", "房主未配置可用的 AI 草稿执行器"));
      return;
    }
    this.deliver(requester, status(request.jobId, "running", "房主正在生成角色草稿"));
    const timeout = globalThis.setTimeout(() => controller.abort(new Error("角色草稿执行超时")), this.timeoutMs);
    try {
      const raw = await this.executor.executeCharacterDraft({
        jobId: request.jobId,
        task: "character-draft",
        provider: this.provider,
        model: this.model,
        prompt: String(request.input.prompt),
        playerName: String(request.input.playerName),
        ownerSeatId: requester.seatId,
      }, controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("角色草稿执行超时");
      const character = validateCharacterDraft(raw, requester, String(request.input.playerName));
      const terminal = status(request.jobId, "completed", "角色草稿已生成，确认保存前不会发布", { character });
      if (requester.seatId === this.session.localSeat.seatId) {
        // The host reviewing their own draft is meaningless; deliver directly.
        this.deliver(requester, terminal);
      } else {
        this.holdForReview(requester, terminal);
      }
    } catch (error) {
      const message = controller.signal.aborted ? "角色草稿执行超时" : toError(error).message;
      this.deliver(requester, status(request.jobId, "failed", message));
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  private holdForReview(requester: SeatV2, terminal: AiJobStatus): void {
    this.pendingReview.set(terminal.jobId, { requester, terminal });
    this.onHostStatus?.(requester, terminal);
    this.sendToSeatOrPark(requester.seatId, reviewNotice(terminal.jobId));
  }

  private deliver(requester: SeatV2, message: AiJobStatus): void {
    if (requester.seatId !== this.session.localSeat.seatId) this.onHostStatus?.(requester, message);
    this.dispatchToRequester(requester, message);
  }

  private dispatchToRequester(requester: SeatV2, message: AiJobStatus): void {
    if (isTerminalStatus(message.status)) this.terminalByJobId.set(message.jobId, message);
    if (requester.seatId === this.session.localSeat.seatId) {
      this.acceptClientStatus(message);
      return;
    }
    this.sendToSeatOrPark(requester.seatId, message);
  }

  private sendToSeatOrPark(seatId: string, message: AiJobStatus): void {
    if (this.session.sendAiJobStatusToSeat(seatId, message)) return;
    const parked = this.outbox.get(seatId) ?? [];
    // Only the latest status per job matters once the seat comes back.
    this.outbox.set(seatId, [...parked.filter((item) => item.jobId !== message.jobId), message]);
  }

  private acceptClientStatus(message: AiJobStatus): void {
    const pending = this.pendingClients.get(message.jobId);
    if (!pending) {
      // A terminal that arrives after the local timer fired (slow KP review,
      // reconnect) must still reach the UI instead of vanishing: an approved
      // character is recoverable through onClientStatus.
      if (message.status === "completed" || message.status === "failed" || message.status === "cancelled") {
        this.onClientStatus?.(message);
      }
      return;
    }
    if (message.status === "completed") {
      try {
        const character = coc7CharacterSchema.parse(asRecord(message.result).character);
        globalThis.clearTimeout(pending.timer);
        this.pendingClients.delete(message.jobId);
        pending.resolve(character);
      } catch (error) {
        this.rejectPending(message.jobId, new Error(`房主返回了无效角色草稿：${toError(error).message}`));
      }
    } else if (message.status === "failed" || message.status === "cancelled") {
      this.rejectPending(message.jobId, new Error(message.message));
    } else {
      // The host is alive and still holds this job; restart the full wait.
      globalThis.clearTimeout(pending.timer);
      pending.timer = this.armClientTimer(message.jobId);
      if (isReviewNotice(message)) pending.awaitingReview = true;
      this.onClientStatus?.(message);
    }
  }

  private armClientTimer(jobId: string): ReturnType<typeof globalThis.setTimeout> {
    return globalThis.setTimeout(() => {
      const pending = this.pendingClients.get(jobId);
      if (!pending) return;
      this.pendingClients.delete(jobId);
      pending.reject(new Error(pending.awaitingReview
        ? "KP 尚未审核；若 KP 通过草稿，这里会再次提示载入，也可稍后重新申请"
        : "角色草稿请求超时"));
    }, this.timeoutMs + 5_000);
  }

  private rejectPending(jobId: string, error: Error): void {
    const pending = this.pendingClients.get(jobId);
    if (!pending) return;
    globalThis.clearTimeout(pending.timer);
    this.pendingClients.delete(jobId);
    pending.reject(error);
  }
}

function validateCharacterDraft(raw: unknown, requester: SeatV2, playerName: string): Coc7Character {
  const record = asRecord(raw);
  const candidate = "character" in record ? asRecord(record.character) : record;
  return coc7CharacterSchema.parse({
    ...candidate,
    schemaVersion: 1,
    id: typeof candidate.id === "string" && candidate.id.length > 0
      ? candidate.id
      : globalThis.crypto.randomUUID(),
    ownerPeerId: requester.seatId,
    playerName,
    updatedAt: new Date().toISOString(),
    extensions: asOptionalRecord(candidate.extensions),
  });
}

function validatePrompt(value: unknown): string {
  if (typeof value !== "string") throw new Error("角色描述必须是文本");
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (length === 0) throw new Error("请先描述想创建的调查员");
  if (length > MAX_PROMPT_CODE_POINTS) throw new Error(`角色描述不能超过 ${MAX_PROMPT_CODE_POINTS} 个字符`);
  return normalized;
}

function validatePlayerName(value: unknown): string {
  if (typeof value !== "string") throw new Error("玩家名必须是文本");
  const normalized = value.trim();
  if (normalized.length === 0 || Array.from(normalized).length > 160) throw new Error("玩家名长度必须为 1–160 个字符");
  return normalized;
}

function status(
  jobId: string,
  state: AiJobStatus["status"],
  message: string,
  result?: unknown,
): AiJobStatus {
  return {
    kind: "ai.job.status",
    jobId,
    status: state,
    message: message.slice(0, 1_000),
    ...(result === undefined ? {} : { result }),
  };
}

function reviewNotice(jobId: string): AiJobStatus {
  return status(jobId, "running", "草稿已生成，等待 KP 审核", { pendingReview: true });
}

function isReviewNotice(message: AiJobStatus): boolean {
  return Boolean(
    message.result && typeof message.result === "object"
    && (message.result as { pendingReview?: unknown }).pendingReview === true,
  );
}

function isTerminalStatus(state: AiJobStatus["status"]): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("结果必须是 JSON 对象");
  return value as Record<string, unknown>;
}

function asOptionalRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
