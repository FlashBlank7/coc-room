import { invoke } from "@tauri-apps/api/core";
import {
  runWebDevelopmentAiTask,
  type WebDevelopmentAiBridgeRunner,
} from "./web-development-ai-bridge";
import {
  moduleNpcSchema,
  roomEventV2Schema,
  type NpcInteractionSessionV1,
  type RoomEntityV2,
  type RoomEventProposalV2,
  type RoomEventV2,
  type RoomWorldStateV2,
} from "@coc-room/protocol";

export const NPC_CONTEXT_MAX_PINS = 12;
export const NPC_CONTEXT_MAX_MESSAGES = 40;
export const NPC_CONTEXT_MAX_MESSAGE_CODE_POINTS = 24_000;
export const NPC_CONTEXT_MAX_PIN_CODE_POINTS = 120_000;

export interface NpcReplyOutputV1 {
  spokenText: string;
  stageDirection?: string;
  emotion?: string;
}

export interface RestrictedNpcContextPinV1 {
  id: string;
  title: string;
  content: string;
}

export interface RestrictedNpcPanelMessageV1 {
  id: string;
  role: "human" | "npc";
  content: string;
  senderLabel?: string;
}

/** Exact snake_case shape consumed by the Python NPCV1 boundary. */
export interface RestrictedNpcCardV1 {
  id: string;
  name: string;
  description: string;
  player_description?: string;
  role: string;
  motivations: string[];
  traits: string[];
  character?: {
    characteristics: Record<string, number>;
    skills: Record<string, number>;
    hit_points?: number;
    sanity?: number;
  };
  source_refs: [];
}

/**
 * This is deliberately the entire provider boundary. Do not add a room object,
 * module object, file path, database handle, network configuration, or tool list.
 */
export interface RestrictedNpcReplyRequestV1 {
  provider: "deepseek" | "codex";
  model: string;
  npcCard: RestrictedNpcCardV1;
  pins: RestrictedNpcContextPinV1[];
  messages: RestrictedNpcPanelMessageV1[];
}

export interface RestrictedNpcReplyProvider {
  generateReply(
    request: RestrictedNpcReplyRequestV1,
    options: { signal: AbortSignal; requestId: string },
  ): Promise<NpcReplyOutputV1>;
}

export type NpcInteractionJobState = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface NpcInteractionJobStatusV1 {
  kind: "ai.job.status";
  jobId: string;
  task: "npc-dialogue";
  sessionId: string;
  triggerMessageId: string;
  status: NpcInteractionJobState;
  message: string;
}

export interface NpcShadowReplyV1 {
  jobId: string;
  sessionId: string;
  triggerMessageId: string;
  reply: NpcReplyOutputV1;
}

export interface NpcInteractionBrokerOptions {
  /** Must return the host's current authoritative world, never a player's projection. */
  getWorld(): RoomWorldStateV2;
  provider: RestrictedNpcReplyProvider;
  publish(proposal: RoomEventProposalV2): Promise<unknown>;
  onStatus?(status: NpcInteractionJobStatusV1): void;
  /** Shadow results are host-local review data and must never be relayed automatically. */
  onShadowReply?(result: NpcShadowReplyV1): void;
  maxConcurrent?: number;
  maxQueued?: number;
  timeoutMs?: number;
  randomUuid?: () => string;
}

interface PendingNpcJob {
  jobId: string;
  sessionId: string;
  triggerMessageId: string;
  triggerMessage: RestrictedNpcPanelMessageV1;
}

interface RunningNpcJob extends PendingNpcJob {
  controller: AbortController;
}

export type ObserveNpcEventResult = "ignored" | "duplicate" | "queued" | "rejected";

/**
 * Host-only scheduler for automatic NPC panel replies.
 *
 * It consumes an already sequenced human panel event, reconstructs context from
 * that panel only, and emits at most one NPC-message proposal. Provider output
 * never re-enters this trigger path because non-human messages are ignored.
 */
export class NpcInteractionBroker {
  private readonly getWorld: () => RoomWorldStateV2;
  private readonly provider: RestrictedNpcReplyProvider;
  private readonly publish: (proposal: RoomEventProposalV2) => Promise<unknown>;
  private readonly onStatus?: (status: NpcInteractionJobStatusV1) => void;
  private readonly onShadowReply?: (result: NpcShadowReplyV1) => void;
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly timeoutMs: number;
  private readonly randomUuid: () => string;
  private readonly observedHumanMessages = new Set<string>();
  private readonly stoppedSessions = new Set<string>();
  private readonly queue: PendingNpcJob[] = [];
  private readonly running = new Map<string, RunningNpcJob>();
  private idleWaiters: Array<() => void> = [];
  private disposed = false;

  constructor(options: NpcInteractionBrokerOptions) {
    this.getWorld = options.getWorld;
    this.provider = options.provider;
    this.publish = options.publish;
    this.onStatus = options.onStatus;
    this.onShadowReply = options.onShadowReply;
    this.maxConcurrent = boundedInteger(options.maxConcurrent ?? 1, 1, 4, "maxConcurrent");
    this.maxQueued = boundedInteger(options.maxQueued ?? 16, 1, 128, "maxQueued");
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 90_000, 1, 10 * 60_000, "timeoutMs");
    this.randomUuid = options.randomUuid ?? (() => globalThis.crypto.randomUUID());
  }

  /**
   * Marks an initial/replayed authority log as already observed without creating
   * jobs. Call this before subscribing to live commits after an app restart.
   */
  primeHistory(candidates: readonly RoomEventV2[]): void {
    for (const candidate of candidates) {
      const event = roomEventV2Schema.parse(candidate);
      if (event.type === "npc.session.message" && event.payload.role === "human") {
        this.observedHumanMessages.add(event.payload.messageId);
      }
    }
  }

  observeEvent(candidate: RoomEventV2): ObserveNpcEventResult {
    if (this.disposed) return "ignored";
    const event = roomEventV2Schema.parse(candidate);
    if (event.type === "npc.session.upserted") {
      if (event.payload.session.status === "active" && event.payload.session.autoReply) {
        this.stoppedSessions.delete(event.payload.session.sessionId);
      } else {
        this.stopSession(event.payload.session.sessionId, "NPC 自动回复已停止");
      }
      return "ignored";
    }
    if (event.type !== "npc.session.message" || event.payload.role !== "human") return "ignored";

    // Mark before checking eligibility: enabling auto-reply later must not replay old messages.
    if (this.observedHumanMessages.has(event.payload.messageId)) return "duplicate";
    this.observedHumanMessages.add(event.payload.messageId);

    const session = this.getWorld().npcSessions.get(event.payload.sessionId);
    if (!isRunnableSession(session) || this.stoppedSessions.has(event.payload.sessionId)) return "ignored";

    if (this.queue.length + this.running.size >= this.maxQueued + this.maxConcurrent) {
      const rejected: PendingNpcJob = {
        jobId: this.randomUuid(),
        sessionId: event.payload.sessionId,
        triggerMessageId: event.payload.messageId,
        triggerMessage: {
          id: event.payload.messageId,
          role: "human",
          content: event.payload.spokenText,
        },
      };
      this.emitStatus(rejected, "failed", "NPC 自动回复队列已满");
      return "rejected";
    }

    const job: PendingNpcJob = {
      jobId: this.randomUuid(),
      sessionId: event.payload.sessionId,
      triggerMessageId: event.payload.messageId,
      triggerMessage: {
        id: event.payload.messageId,
        role: "human",
        content: event.payload.spokenText,
      },
    };
    this.queue.push(job);
    this.emitStatus(job, "queued", "NPC 回复已排队");
    this.drain();
    return "queued";
  }

  /** Immediately cancels running work and removes queued work for one panel. */
  stopSession(sessionId: string, message = "NPC 自动回复已由 KP 停止"): void {
    this.stoppedSessions.add(sessionId);
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const job = this.queue[index]!;
      if (job.sessionId !== sessionId) continue;
      this.queue.splice(index, 1);
      this.emitStatus(job, "cancelled", message);
    }
    for (const job of this.running.values()) {
      if (job.sessionId === sessionId) job.controller.abort(new NpcReplyCancelledError(message));
    }
    this.resolveIdleIfNeeded();
  }

  /** A later active/autoReply session revision may explicitly re-enable the panel. */
  resumeSession(sessionId: string): void {
    if (!this.disposed) this.stoppedSessions.delete(sessionId);
  }

  shutdown(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of this.queue.splice(0)) this.emitStatus(job, "cancelled", "NPC 回复代理已关闭");
    for (const job of this.running.values()) {
      job.controller.abort(new NpcReplyCancelledError("NPC 回复代理已关闭"));
    }
    this.resolveIdleIfNeeded();
  }

  whenIdle(): Promise<void> {
    if (this.queue.length === 0 && this.running.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private drain(): void {
    while (!this.disposed && this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift()!;
      const controller = new AbortController();
      const running = { ...job, controller };
      this.running.set(job.jobId, running);
      void this.run(running).finally(() => {
        this.running.delete(job.jobId);
        this.drain();
        this.resolveIdleIfNeeded();
      });
    }
  }

  private async run(job: RunningNpcJob): Promise<void> {
    const before = this.readRunnableContext(job);
    if (!before) {
      this.emitStatus(job, "cancelled", "NPC 会话已停止或上下文不可用");
      return;
    }
    this.emitStatus(job, "running", "NPC 正在生成回复");

    const timeoutHandle = globalThis.setTimeout(() => {
      job.controller.abort(new NpcReplyTimeoutError());
    }, this.timeoutMs);
    try {
      const rawReply = await raceAbort(
        this.provider.generateReply(before.request, {
          signal: job.controller.signal,
          requestId: job.jobId,
        }),
        job.controller.signal,
      );
      const reply = parseNpcReplyOutputV1(rawReply);
      const current = this.getWorld().npcSessions.get(job.sessionId);
      if (
        job.controller.signal.aborted
        || this.stoppedSessions.has(job.sessionId)
        || !isRunnableSession(current)
      ) {
        this.emitStatus(job, "cancelled", "NPC 回复已停止，未发布结果");
        return;
      }

      if (current.mode === "shadow") {
        this.onShadowReply?.({
          jobId: job.jobId,
          sessionId: job.sessionId,
          triggerMessageId: job.triggerMessageId,
          reply,
        });
        this.emitStatus(job, "completed", "影子回复已完成，仅 KP 本机可见");
        return;
      }

      await this.publish({
        type: "npc.session.message",
        audience: current.audience,
        payload: {
          sessionId: current.sessionId,
          messageId: this.randomUuid(),
          role: "npc",
          spokenText: reply.spokenText,
          ...(reply.stageDirection === undefined ? {} : { stageDirection: reply.stageDirection }),
          ...(reply.emotion === undefined ? {} : { emotion: reply.emotion }),
        },
      });
      this.emitStatus(job, "completed", "NPC 回复已发布到当前互动面板");
    } catch (error) {
      if (job.controller.signal.aborted || error instanceof NpcReplyCancelledError) {
        const timedOut = job.controller.signal.reason instanceof NpcReplyTimeoutError;
        this.emitStatus(job, timedOut ? "failed" : "cancelled", timedOut
          ? "NPC 回复超时，未生成替代内容"
          : "NPC 回复已取消，未发布结果");
        return;
      }
      this.emitStatus(job, "failed", safeProviderFailure(error));
    } finally {
      globalThis.clearTimeout(timeoutHandle);
    }
  }

  private readRunnableContext(job: PendingNpcJob): { request: RestrictedNpcReplyRequestV1 } | undefined {
    const world = this.getWorld();
    const session = world.npcSessions.get(job.sessionId);
    if (!isRunnableSession(session) || this.stoppedSessions.has(job.sessionId)) return;
    const npc = world.entities.get(session.npcEntityId);
    if (!npc || npc.kind !== "npc") return;

    const npcCard = roomNpcEntityToCard(npc);
    const panelMessages = (world.npcMessages.get(session.sessionId) ?? [])
      .filter((message) => message.role === "human" || message.role === "npc")
      .map((message) => ({
        id: message.messageId,
        role: message.role as "human" | "npc",
        content: message.spokenText,
      }));
    // Integration may call observeEvent immediately before or after projecting the
    // committed event. Include the trigger exactly once in either ordering.
    if (!panelMessages.some(({ id }) => id === job.triggerMessageId)) {
      panelMessages.push(clonePanelMessage(job.triggerMessage));
    }
    const messages = selectNpcPanelMessages(panelMessages);
    const pins = selectNpcPins(session);

    // Construct keys explicitly. This object is the anti-confused-deputy boundary.
    return {
      request: {
        provider: session.provider,
        model: session.model,
        npcCard,
        pins,
        messages,
      },
    };
  }

  private emitStatus(job: PendingNpcJob, status: NpcInteractionJobState, message: string): void {
    this.onStatus?.({
      kind: "ai.job.status",
      jobId: job.jobId,
      task: "npc-dialogue",
      sessionId: job.sessionId,
      triggerMessageId: job.triggerMessageId,
      status,
      message,
    });
  }

  private resolveIdleIfNeeded(): void {
    if (this.queue.length !== 0 || this.running.size !== 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}

/** Selects only the newest contiguous panel suffix, measured as Unicode code points. */
export function selectNpcPanelMessages(
  messages: readonly RestrictedNpcPanelMessageV1[],
): RestrictedNpcPanelMessageV1[] {
  const recent = messages.slice(-NPC_CONTEXT_MAX_MESSAGES);
  const selectedNewestFirst: RestrictedNpcPanelMessageV1[] = [];
  let remaining = NPC_CONTEXT_MAX_MESSAGE_CODE_POINTS;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index]!;
    const codePoints = [...message.content];
    if (codePoints.length <= remaining) {
      selectedNewestFirst.push(clonePanelMessage(message));
      remaining -= codePoints.length;
      continue;
    }
    if (selectedNewestFirst.length === 0 && remaining > 0) {
      selectedNewestFirst.push({
        ...clonePanelMessage(message),
        content: codePoints.slice(-remaining).join(""),
      });
      remaining = 0;
    }
    break;
  }
  return selectedNewestFirst.reverse();
}

export function roomNpcEntityToCard(entity: RoomEntityV2): RestrictedNpcCardV1 {
  if (entity.kind !== "npc") throw new Error("NPC interaction requires an NPC room entity");
  const embedded = moduleNpcSchema.safeParse(entity.data.npcCard);
  if (embedded.success) return moduleNpcToRestrictedCard(embedded.data);

  const candidate = {
    id: entity.entityId,
    name: entity.name,
    description: entity.description,
    sourceRefs: [],
    ...(typeof entity.data.playerDescription === "string"
      ? { playerDescription: entity.data.playerDescription }
      : {}),
    role: typeof entity.data.role === "string" ? entity.data.role : "",
    motivation: typeof entity.data.motivation === "string" ? entity.data.motivation : "",
    traits: Array.isArray(entity.data.traits)
      ? entity.data.traits.filter((value): value is string => typeof value === "string")
      : [],
    ...(isRecord(entity.data.character) ? { character: entity.data.character } : {}),
  };
  return moduleNpcToRestrictedCard(moduleNpcSchema.parse(candidate));
}

function moduleNpcToRestrictedCard(value: ReturnType<typeof moduleNpcSchema.parse>): RestrictedNpcCardV1 {
  return {
    id: value.id,
    name: value.name,
    description: value.description,
    ...(value.playerDescription === undefined ? {} : { player_description: value.playerDescription }),
    role: value.role,
    motivations: value.motivation ? [value.motivation] : [],
    traits: [...value.traits],
    ...(value.character === undefined ? {} : {
      character: {
        characteristics: { ...value.character.characteristics },
        skills: { ...value.character.skills },
        ...(value.character.hitPoints === undefined ? {} : { hit_points: value.character.hitPoints }),
        ...(value.character.sanity === undefined ? {} : { sanity: value.character.sanity }),
      },
    }),
    // Source positions provide no dialogue value and are intentionally omitted.
    source_refs: [],
  };
}

function selectNpcPins(session: NpcInteractionSessionV1): RestrictedNpcContextPinV1[] {
  const pins: RestrictedNpcContextPinV1[] = [];
  let totalCodePoints = 0;
  for (const pin of session.pinnedContext.slice(0, NPC_CONTEXT_MAX_PINS)) {
    const next = [...pin.title].length + [...pin.body].length;
    if (totalCodePoints + next > NPC_CONTEXT_MAX_PIN_CODE_POINTS) break;
    pins.push({ id: pin.pinId, title: pin.title, content: pin.body });
    totalCodePoints += next;
  }
  return pins;
}

function isRunnableSession(
  session: NpcInteractionSessionV1 | undefined,
): session is NpcInteractionSessionV1 {
  return session !== undefined && session.status === "active" && session.autoReply;
}

function clonePanelMessage(message: RestrictedNpcPanelMessageV1): RestrictedNpcPanelMessageV1 {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    ...(message.senderLabel === undefined ? {} : { senderLabel: message.senderLabel }),
  };
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function safeProviderFailure(error: unknown): string {
  if (error instanceof NpcReplyProviderError) return error.publicMessage;
  if (error instanceof InvalidNpcReplyError) return "NPC 提供者返回了非法结构，未发布结果";
  return "NPC 提供者失败，未生成替代内容";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class NpcReplyCancelledError extends Error {}
class NpcReplyTimeoutError extends Error {}
class InvalidNpcReplyError extends Error {}

export class NpcReplyProviderError extends Error {
  constructor(readonly publicMessage: string) {
    super(publicMessage);
    this.name = "NpcReplyProviderError";
  }
}

export type NpcReplyInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

/**
 * Narrow Tauri adapter. The native command is expected to invoke the Python
 * sidecar's NPC-only JSONL operation and attach credentials inside Rust; no key,
 * path, room snapshot, tool declaration, or arbitrary prompt crosses this API.
 */
export class TauriNpcReplyProvider implements RestrictedNpcReplyProvider {
  constructor(
    private readonly invokeNative: NpcReplyInvoke = invoke,
    private readonly runWeb: WebDevelopmentAiBridgeRunner = runWebDevelopmentAiTask,
  ) {}

  async generateReply(
    input: RestrictedNpcReplyRequestV1,
    options: { signal: AbortSignal; requestId: string },
  ): Promise<NpcReplyOutputV1> {
    if (options.signal.aborted) throw new NpcReplyCancelledError();
    const browserRequest: Record<string, unknown> = {
      id: options.requestId,
      provider: input.provider,
      model: input.model,
      npcCard: input.npcCard,
      pins: input.pins,
      messages: input.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        ...(message.senderLabel === undefined ? {} : { senderLabel: message.senderLabel }),
      })),
    };
    if (!("__TAURI_INTERNALS__" in globalThis)) {
      const raw = await this.runWeb("npc-reply", browserRequest, options.signal);
      return extractNativeNpcReply(raw);
    }

    const nativeRequest = {
      id: options.requestId,
      action: "generate_npc_reply",
      provider: input.provider,
      model: input.model,
      npc_card: input.npcCard,
      pins: input.pins,
      messages: input.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        ...(message.senderLabel === undefined ? {} : { sender_label: message.senderLabel }),
      })),
    };
    const resultPromise = this.invokeNative<unknown>("run_npc_reply", { request: nativeRequest });
    const cancel = () => {
      // Cancellation is a separate narrow command so stopping a panel also
      // terminates the Python/Codex process tree instead of merely hiding output.
      void this.invokeNative<boolean>("cancel_npc_reply", { requestId: options.requestId }).catch(() => undefined);
    };
    options.signal.addEventListener("abort", cancel, { once: true });
    try {
      const raw = await raceAbort(resultPromise, options.signal);
      return extractNativeNpcReply(raw);
    } finally {
      options.signal.removeEventListener("abort", cancel);
    }
  }
}

function parseNpcReplyOutputV1(value: unknown): NpcReplyOutputV1 {
  if (!isRecord(value)) throw new InvalidNpcReplyError("NPC reply must be an object");
  const keys = Object.keys(value);
  if (keys.some((key) => !["spokenText", "stageDirection", "emotion"].includes(key))) {
    throw new InvalidNpcReplyError("NPC reply contains unsupported fields");
  }
  if (typeof value.spokenText !== "string" || value.spokenText.length < 1 || value.spokenText.length > 4_000) {
    throw new InvalidNpcReplyError("NPC reply spokenText is invalid");
  }
  if (value.stageDirection !== undefined
    && (typeof value.stageDirection !== "string" || value.stageDirection.length > 2_000)) {
    throw new InvalidNpcReplyError("NPC reply stageDirection is invalid");
  }
  if (value.emotion !== undefined
    && (typeof value.emotion !== "string" || value.emotion.length > 100)) {
    throw new InvalidNpcReplyError("NPC reply emotion is invalid");
  }
  return {
    spokenText: value.spokenText,
    ...(value.stageDirection === undefined ? {} : { stageDirection: value.stageDirection as string }),
    ...(value.emotion === undefined ? {} : { emotion: value.emotion as string }),
  };
}

function extractNativeNpcReply(value: unknown): NpcReplyOutputV1 {
  if (!Array.isArray(value)) throw new NpcReplyProviderError("NPC sidecar 返回了非法消息列表");
  for (const message of value) {
    if (!isRecord(message) || typeof message.type !== "string") continue;
    if (message.type === "error") {
      const error = isRecord(message.error) ? message.error : undefined;
      throw new NpcReplyProviderError(
        error && typeof error.message === "string" ? error.message : "NPC 提供者拒绝了请求",
      );
    }
  }
  for (const message of value) {
    if (!isRecord(message) || message.type !== "result" || !isRecord(message.result)) continue;
    if (message.result.reply !== undefined) return parseNpcReplyOutputV1(message.result.reply);
  }
  throw new NpcReplyProviderError("NPC 提供者没有返回回复");
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new NpcReplyCancelledError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new NpcReplyCancelledError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
