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
    const code = isRecord(message.error) ? message.error.code : undefined;
    throw new Error(characterDraftErrorMessage(code));
  }
  for (const message of value) {
    if (!isRecord(message) || message.type !== "result" || !isRecord(message.result)) continue;
    if (message.result.character !== undefined) return message.result.character;
  }
  throw new Error("角色草稿提供者没有返回角色卡");
}

// Only map fixed codes. Upstream messages may contain prompts or credentials.
function characterDraftErrorMessage(code: unknown): string {
  switch (code) {
    case "CODEX_NOT_FOUND": return "未找到本机 Codex。请在设置中检查 Codex 服务，或改用已配置的 DeepSeek。（CODEX_NOT_FOUND）";
    case "CODEX_NOT_AUTHENTICATED":
    case "CODEX_LOGIN_REQUIRED": return "本机 Codex 尚未登录。请完成登录后重新生成角色。（CODEX_LOGIN_REQUIRED）";
    case "CODEX_INCOMPATIBLE": return "本机 Codex 版本不支持角色生成，请更新后重试。（CODEX_INCOMPATIBLE）";
    case "MISSING_CREDENTIAL":
    case "DEEPSEEK_KEY_MISSING": return "没有可用的 DeepSeek API Key，请到设置中保存后重试。（MISSING_CREDENTIAL）";
    case "CODEX_TIMEOUT": return "Codex 生成角色超时，请稍后重试。（CODEX_TIMEOUT）";
    case "CODEX_EXEC_FAILED": return "Codex 生成进程未能完成，请检查设置中的模型是否可用后重试。（CODEX_EXEC_FAILED）";
    case "CODEX_STATUS_FAILED": return "无法检查本机 Codex 登录状态，请在设置中重新检查服务。（CODEX_STATUS_FAILED）";
    case "INVALID_STRUCTURE": return "AI 返回的角色资料格式不完整，无法保存为角色卡，请重新生成。（INVALID_STRUCTURE）";
    case "EMPTY_RESPONSE": return "AI 没有返回角色资料，请重新生成。（EMPTY_RESPONSE）";
    case "TRUNCATED_RESPONSE": return "AI 返回的角色资料被截断，请重新生成。（TRUNCATED_RESPONSE）";
    case "PROVIDER_ERROR": return "AI 服务请求失败，请检查模型和服务连接后重试。（PROVIDER_ERROR）";
    case "INVALID_CHARACTER_TASK": return "角色生成请求有误，请刷新页面后重试。（INVALID_CHARACTER_TASK）";
    case "INTERNAL_ERROR":
    case "BRIDGE_INTERNAL_ERROR": return "角色生成服务发生内部错误，请重试；若仍失败，请反馈错误码 INTERNAL_ERROR。";
    default: return "角色生成失败，请检查 AI 服务后重试。（LOCAL_AI_FAILED）";
  }
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
