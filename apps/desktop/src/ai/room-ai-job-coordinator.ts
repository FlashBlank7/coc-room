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
}

interface QueuedJob {
  request: AiJobRequest;
  requester: SeatV2;
}

interface PendingClientRequest {
  resolve(character: Coc7Character): void;
  reject(error: Error): void;
  timer: ReturnType<typeof globalThis.setTimeout>;
}

const MAX_PROMPT_CODE_POINTS = 8_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Host-controlled broker for room AI drafts. Remote peers can request the
 * fixed `character-draft` operation only; provider/model selection and the
 * actual executor always stay on the host.
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
  private readonly queue: QueuedJob[] = [];
  private readonly running = new Map<string, AbortController>();
  private readonly seenJobIds = new Set<string>();
  private readonly pendingClients = new Map<string, PendingClientRequest>();
  private disposed = false;

  constructor(options: RoomAiJobCoordinatorOptions) {
    this.session = options.session;
    this.executor = options.executor;
    this.provider = options.provider;
    this.model = options.model.trim();
    this.maxConcurrent = clampInteger(options.maxConcurrent ?? 2, 1, 4);
    this.maxQueued = clampInteger(options.maxQueued ?? 16, 1, 64);
    this.timeoutMs = clampInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, 10 * 60_000);
    this.onHostStatus = options.onHostStatus;
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
      const timer = globalThis.setTimeout(() => {
        this.pendingClients.delete(jobId);
        reject(new Error("角色草稿请求超时"));
      }, this.timeoutMs + 5_000);
      this.pendingClients.set(jobId, { resolve, reject, timer });
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

  shutdown(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.splice(0);
    for (const controller of this.running.values()) controller.abort(new Error("房间 AI 草稿代理已经关闭"));
    this.running.clear();
    for (const [jobId] of this.pendingClients) this.rejectPending(jobId, new Error("房间 AI 草稿代理已经关闭"));
  }

  private acceptHostRequest(requester: SeatV2, request: AiJobRequest): void {
    if (this.disposed) return;
    if (this.seenJobIds.has(request.jobId)) return;
    this.seenJobIds.add(request.jobId);

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
      this.deliver(requester, status(request.jobId, "completed", "角色草稿已生成，确认保存前不会发布", { character }));
    } catch (error) {
      const message = controller.signal.aborted ? "角色草稿执行超时" : toError(error).message;
      this.deliver(requester, status(request.jobId, "failed", message));
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  private deliver(requester: SeatV2, message: AiJobStatus): void {
    this.onHostStatus?.(requester, message);
    if (requester.seatId === this.session.localSeat.seatId) {
      this.acceptClientStatus(message);
      return;
    }
    this.session.sendAiJobStatusToSeat(requester.seatId, message);
  }

  private acceptClientStatus(message: AiJobStatus): void {
    const pending = this.pendingClients.get(message.jobId);
    if (!pending) return;
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
    }
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
