import { invoke } from "@tauri-apps/api/core";
import {
  moduleNpcSchema,
  type RoomEntityV2,
  type RoomEventV2,
} from "@coc-room/protocol";
import {
  runWebDevelopmentAiTask,
  type WebDevelopmentAiBridgeRunner,
} from "./web-development-ai-bridge";

/**
 * Manual "让助手代答" for the shared story stream. The keeper speaks as NPCs
 * directly in the room chat (chat.message with a persona); when they want the
 * assistant to draft the NPC's next line, this module rebuilds the recent
 * on-screen dialogue as the provider context and returns one reply for the
 * keeper to publish, edit, or discard. There is no session, no auto-reply, no
 * pinned context — the NPC card plus what everyone just said is the whole
 * boundary.
 */

export const NPC_CONTEXT_MAX_MESSAGES = 200;
export const NPC_CONTEXT_MAX_MESSAGE_CODE_POINTS = 100_000;

export interface NpcReplyOutputV1 {
  spokenText: string;
  stageDirection?: string;
  emotion?: string;
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
  pins: [];
  messages: RestrictedNpcPanelMessageV1[];
}

/**
 * Turns the recent shared story stream into the NPC's conversation context.
 * Chat lines spoken as this NPC become its own turns; everything else spoken
 * in the room (players and the keeper alike) is a human turn labeled with the
 * on-screen speaker name. Legacy per-session NPC messages are included too so
 * conversations that started under the old panel still read coherently.
 */
export function collectSceneDialogue(
  events: readonly RoomEventV2[],
  npc: Pick<RoomEntityV2, "entityId" | "name">,
): RestrictedNpcPanelMessageV1[] {
  const collected: RestrictedNpcPanelMessageV1[] = [];
  for (const event of events) {
    if (event.type === "chat.message") {
      const persona = event.payload.persona;
      const speaksAsThisNpc = persona !== undefined
        && (persona.entityId === npc.entityId || persona.name === npc.name);
      collected.push({
        id: event.eventId,
        role: speaksAsThisNpc ? "npc" : "human",
        content: event.payload.message,
        ...(speaksAsThisNpc ? {} : { senderLabel: persona?.name ?? event.sender.displayName }),
      });
      continue;
    }
    if (event.type === "npc.session.message") {
      if (event.payload.role === "system") continue;
      collected.push({
        id: event.payload.messageId,
        role: event.payload.role,
        content: event.payload.spokenText,
        ...(event.payload.role === "npc" ? {} : { senderLabel: event.sender.displayName }),
      });
    }
  }
  return selectNpcPanelMessages(collected);
}

/** Newest-suffix selection under the message-count and code-point budgets. */
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
      selectedNewestFirst.push({ ...message });
      remaining -= codePoints.length;
      continue;
    }
    if (selectedNewestFirst.length === 0 && remaining > 0) {
      selectedNewestFirst.push({ ...message, content: codePoints.slice(-remaining).join("") });
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

export class NpcReplyProviderError extends Error {
  constructor(readonly publicMessage: string) {
    super(publicMessage);
    this.name = "NpcReplyProviderError";
  }
}

class InvalidNpcReplyError extends Error {}

export type NpcReplyInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

export interface DraftSceneNpcReplyOptions {
  npc: RoomEntityV2;
  events: readonly RoomEventV2[];
  provider: "deepseek" | "codex";
  model: string;
  signal: AbortSignal;
  requestId?: string;
  invokeNative?: NpcReplyInvoke;
  runWeb?: WebDevelopmentAiBridgeRunner;
}

/** One manual draft: NPC card + the visible recent dialogue, nothing else. */
export async function draftSceneNpcReply(options: DraftSceneNpcReplyOptions): Promise<NpcReplyOutputV1> {
  const { npc, events, provider, model, signal } = options;
  const requestId = options.requestId ?? globalThis.crypto.randomUUID();
  const invokeNative = options.invokeNative ?? (invoke as NpcReplyInvoke);
  const runWeb = options.runWeb ?? runWebDevelopmentAiTask;

  if (signal.aborted) throw signal.reason ?? new Error("NPC 代答已取消");
  const request: RestrictedNpcReplyRequestV1 = {
    provider,
    model,
    npcCard: roomNpcEntityToCard(npc),
    pins: [],
    messages: collectSceneDialogue(events, npc),
  };

  if (!("__TAURI_INTERNALS__" in globalThis)) {
    const raw = await runWeb("npc-reply", {
      id: requestId,
      provider: request.provider,
      model: request.model,
      npcCard: request.npcCard,
      pins: request.pins,
      messages: request.messages,
    }, signal);
    return extractNativeNpcReply(raw);
  }

  const nativeRequest = {
    id: requestId,
    action: "generate_npc_reply",
    provider: request.provider,
    model: request.model,
    npc_card: request.npcCard,
    pins: request.pins,
    messages: request.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      ...(message.senderLabel === undefined ? {} : { sender_label: message.senderLabel }),
    })),
  };
  const resultPromise = invokeNative<unknown>("run_npc_reply", { request: nativeRequest });
  const cancel = () => {
    // Cancellation is a separate narrow command so stopping a draft also
    // terminates the Python/Codex process tree instead of merely hiding output.
    void invokeNative<boolean>("cancel_npc_reply", { requestId }).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const raw = await raceAbort(resultPromise, signal);
    return extractNativeNpcReply(raw);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function parseNpcReplyOutputV1(value: unknown): NpcReplyOutputV1 {
  if (!isRecord(value)) throw new InvalidNpcReplyError("NPC reply must be an object");
  const keys = Object.keys(value);
  if (keys.some((key) => !["spokenText", "stageDirection", "emotion"].includes(key))) {
    throw new InvalidNpcReplyError("NPC reply contains unsupported fields");
  }
  if (typeof value.spokenText !== "string" || value.spokenText.length < 1 || value.spokenText.length > 20_000) {
    throw new InvalidNpcReplyError("NPC reply spokenText is invalid");
  }
  if (value.stageDirection !== undefined
    && (typeof value.stageDirection !== "string" || value.stageDirection.length > 10_000)) {
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
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("NPC 代答已取消"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("NPC 代答已取消"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
