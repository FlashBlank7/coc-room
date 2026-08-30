import { invoke } from "@tauri-apps/api/core";
import {
  runWebDevelopmentAiTask,
  type WebDevelopmentAiBridgeRunner,
} from "./web-development-ai-bridge";

export type NpcStatsProvider = "deepseek" | "codex";

export interface NpcStatsCharacterV1 {
  characteristics: Record<string, number>;
  skills: Record<string, number>;
  hitPoints: number;
  sanity?: number;
}

export interface NpcStatsDraftRequestV1 {
  npcId: string;
  name: string;
  description: string;
  guidance: string;
  provider: NpcStatsProvider;
  model: string;
}

export interface NpcStatsDraftV1 {
  npcId: string;
  provider: NpcStatsProvider;
  model: string;
  character: NpcStatsCharacterV1;
}

export type NpcStatsDraftInvoke = (
  command: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

const REQUEST_KEYS = ["npcId", "name", "description", "guidance", "provider", "model"] as const;

/**
 * Host-local fixed executor. There is deliberately no room-message adapter and
 * no generic prompt, path, tool, URL, or arbitrary Codex argument surface.
 */
export class TauriNpcStatsDraftExecutor {
  constructor(
    private readonly invokeNative: NpcStatsDraftInvoke = (command, args) => invoke(command, args),
    private readonly runWeb: WebDevelopmentAiBridgeRunner = runWebDevelopmentAiTask,
  ) {}

  async generateDraft(input: NpcStatsDraftRequestV1, signal: AbortSignal): Promise<NpcStatsDraftV1> {
    const safe = validateNpcStatsDraftRequest(input);
    if (signal.aborted) throw signal.reason ?? new Error("NPC 属性草稿已取消");

    const requestId = globalThis.crypto.randomUUID();
    const request: Record<string, unknown> = {
      id: requestId,
      provider: safe.provider,
      model: safe.model,
      npcId: safe.npcId,
      name: safe.name,
      description: safe.description,
      guidance: safe.guidance,
    };
    if (!("__TAURI_INTERNALS__" in globalThis)) {
      return extractNpcStatsDraft(await this.runWeb("npc-stats-draft", request, signal), safe);
    }

    const nativeRequest = {
      id: requestId,
      action: "generate_npc_stats_draft",
      provider: safe.provider,
      model: safe.model,
      npcId: safe.npcId,
      name: safe.name,
      description: safe.description,
      guidance: safe.guidance,
    };
    const operation = this.invokeNative("run_npc_stats_draft", { request: nativeRequest });
    const cancel = () => {
      void this.invokeNative("cancel_npc_stats_draft", { requestId }).catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return extractNpcStatsDraft(await raceAbort(operation, signal), safe);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
}

export const tauriNpcStatsDraftExecutor = new TauriNpcStatsDraftExecutor();

export function validateNpcStatsDraftRequest(candidate: NpcStatsDraftRequestV1): NpcStatsDraftRequestV1 {
  if (!isRecord(candidate) || !hasExactKeys(candidate, REQUEST_KEYS)) {
    throw new Error("NPC 属性草稿请求包含未授权字段");
  }
  if (candidate.provider !== "codex" && candidate.provider !== "deepseek") {
    throw new Error("NPC 属性草稿提供者无效");
  }
  if (!isIdentifier(candidate.npcId)) throw new Error("NPC ID 无效");
  validateText(candidate.name, 1, 300, "NPC 名称");
  validateText(candidate.description, 0, 100_000, "NPC 描述");
  validateText(candidate.guidance, 0, 50_000, "NPC 补充要求");
  if (typeof candidate.model !== "string" || !/^[A-Za-z0-9._-]{0,100}$/.test(candidate.model)) {
    throw new Error("NPC 属性草稿模型名称无效");
  }
  return { ...candidate };
}

function extractNpcStatsDraft(
  value: unknown,
  request: NpcStatsDraftRequestV1,
): NpcStatsDraftV1 {
  if (!Array.isArray(value)) throw new Error("NPC 属性草稿 sidecar 返回了非法消息列表");
  for (const message of value) {
    if (isRecord(message) && message.type === "error") {
      throw new Error("NPC 属性草稿提供者失败，未生成替代内容");
    }
  }
  const results = value.filter(
    (message): message is Record<string, unknown> => isRecord(message) && message.type === "result",
  );
  const resultMessage = results[0];
  if (results.length !== 1 || !resultMessage || !isRecord(resultMessage.result)) {
    throw new Error("NPC 属性草稿提供者没有返回唯一结果");
  }
  const result = resultMessage.result;
  if (!hasExactKeys(result, ["status", "provider", "model", "npcId", "character"])) {
    throw new Error("NPC 属性草稿结果包含未授权字段");
  }
  if (result.status !== "draft" || result.provider !== request.provider || result.npcId !== request.npcId) {
    throw new Error("NPC 属性草稿结果与本地请求不匹配");
  }
  if (typeof result.model !== "string" || result.model.length > 100) {
    throw new Error("NPC 属性草稿结果模型无效");
  }
  return {
    npcId: request.npcId,
    provider: request.provider,
    model: result.model,
    character: parseNpcStatsCharacter(result.character),
  };
}

function parseNpcStatsCharacter(value: unknown): NpcStatsCharacterV1 {
  if (!isRecord(value)) throw new Error("NPC 属性草稿数值不是对象");
  const keys = Object.keys(value);
  if (!keys.every((key) => ["characteristics", "skills", "hitPoints", "sanity"].includes(key))
    || !["characteristics", "skills", "hitPoints"].every((key) => keys.includes(key))) {
    throw new Error("NPC 属性草稿数值字段无效");
  }
  const characteristics = parsePercentageRecord(value.characteristics, 16, "NPC 属性");
  const skills = parsePercentageRecord(value.skills, 100, "NPC 技能");
  if (!isIntegerInRange(value.hitPoints, 0, 99)) throw new Error("NPC HP 无效");
  if (value.sanity !== undefined && !isIntegerInRange(value.sanity, 0, 100)) {
    throw new Error("NPC SAN 无效");
  }
  return {
    characteristics,
    skills,
    hitPoints: value.hitPoints,
    ...(value.sanity === undefined ? {} : { sanity: value.sanity }),
  };
}

function parsePercentageRecord(value: unknown, maximumKeys: number, label: string): Record<string, number> {
  if (!isRecord(value) || Object.keys(value).length > maximumKeys) throw new Error(`${label}无效`);
  const parsed: Record<string, number> = {};
  for (const [key, number] of Object.entries(value)) {
    if ([...key].length < 1 || [...key].length > 120 || !isIntegerInRange(number, 0, 100)) {
      throw new Error(`${label}无效`);
    }
    parsed[key] = number;
  }
  return parsed;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("NPC 属性草稿已取消"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("NPC 属性草稿已取消"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function validateText(value: unknown, minimum: number, maximum: number, label: string): asserts value is string {
  if (typeof value !== "string" || [...value].length < minimum || [...value].length > maximum || value.includes("\0")) {
    throw new Error(`${label}长度无效`);
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
