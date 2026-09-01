import { invoke } from "@tauri-apps/api/core";

import { getRepository } from "../data/repository";
import { generateBrowserDeepSeekCharacterDraft } from "./browser-deepseek-character-draft";
import type {
  CharacterDraftExecutionRequest,
  RoomAiDraftExecutor,
} from "./room-ai-job-coordinator";
import {
  runWebDevelopmentAiTask,
  type WebDevelopmentAiBridgeRunner,
} from "./web-development-ai-bridge";

export type CharacterDraftInvoke = (
  command: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/** Fixed host-side executor; it cannot carry paths, tools, room data, or arbitrary prompts. */
export class TauriCharacterDraftExecutor implements RoomAiDraftExecutor {
  constructor(
    private readonly invokeNative: CharacterDraftInvoke = (command, args) => invoke(command, args),
    private readonly runWeb: WebDevelopmentAiBridgeRunner = runWebDevelopmentAiTask,
  ) {}

  async executeCharacterDraft(
    input: CharacterDraftExecutionRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted) throw signal.reason ?? new Error("角色草稿已取消");

    // Explicit construction is the trust boundary from an untrusted player job.
    const request: Record<string, unknown> = {
      id: input.jobId,
      provider: input.provider,
      model: input.model,
      prompt: input.prompt,
      playerName: input.playerName,
      ownerSeatId: input.ownerSeatId,
    };
    if (!("__TAURI_INTERNALS__" in globalThis)) {
      // DeepSeek is a plain HTTPS API with browser CORS: when the keeper has
      // stored a key in this browser, call it directly — the deployed test
      // site has no local bridge, and even the dev bridge holds no key.
      if (input.provider === "deepseek") {
        const apiKey = (await (await getRepository()).getSetting("deepseekApiKey"))?.trim();
        if (apiKey) {
          return {
            character: await generateBrowserDeepSeekCharacterDraft({
              prompt: input.prompt,
              playerName: input.playerName,
              ownerSeatId: input.ownerSeatId,
              apiKey,
              model: input.model,
              signal,
            }),
          };
        }
        try {
          return extractCharacterDraft(await this.runWeb("character-draft", request, signal));
        } catch (error) {
          if (error instanceof Error && error.message.includes("本地 AI 开发会话")) {
            throw new Error("要在网页端使用 DeepSeek 车卡，请先到 设置 → AI 文字服务(DeepSeek) 保存 API Key。");
          }
          throw error;
        }
      }
      return extractCharacterDraft(await this.runWeb("character-draft", request, signal));
    }

    const nativeRequest = {
      id: input.jobId,
      action: "generate_character_draft",
      provider: input.provider,
      model: input.model,
      prompt: input.prompt,
      playerName: input.playerName,
      ownerSeatId: input.ownerSeatId,
    };
    const operation = this.invokeNative("run_character_draft", { request: nativeRequest });
    const cancel = () => {
      void this.invokeNative("cancel_character_draft", { requestId: input.jobId }).catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return extractCharacterDraft(await raceAbort(operation, signal));
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
}

function extractCharacterDraft(value: unknown): unknown {
  if (!Array.isArray(value)) throw new Error("角色草稿 sidecar 返回了非法消息列表");
  for (const message of value) {
    if (!isRecord(message) || message.type !== "error") continue;
    throw new Error("角色草稿提供者失败，未生成替代内容");
  }
  for (const message of value) {
    if (!isRecord(message) || message.type !== "result" || !isRecord(message.result)) continue;
    if (message.result.character !== undefined) return message.result.character;
  }
  throw new Error("角色草稿提供者没有返回角色卡");
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("角色草稿已取消"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("角色草稿已取消"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
