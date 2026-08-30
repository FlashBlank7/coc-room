import { invoke } from "@tauri-apps/api/core";
import { assetDescriptorV1Schema, type AssetDescriptorV1 } from "@coc-room/protocol";

export const CODEX_IMAGE_JOB_KINDS = [
  "location",
  "npc",
  "character",
  "cover",
  "textlessMap",
] as const;

export type CodexImageJobKind = (typeof CODEX_IMAGE_JOB_KINDS)[number];
export type CodexImageAspectRatio = "square" | "landscape" | "portrait";

/** Native authorization is re-checked against the local V2 host seat. */
export interface CodexImageKeeperAuthorization {
  roomId: string;
  seatId: string;
}

/**
 * Deliberately not a generic Codex prompt.  The Rust command accepts exactly
 * this allow-listed shape and turns the fields into a fixed image-only prompt.
 */
export interface CodexImageJob {
  kind: CodexImageJobKind;
  description: string;
  style?: string;
  aspectRatio?: CodexImageAspectRatio;
  model?: string;
}

export interface CodexImageCapabilities {
  installed: boolean;
  compatible: boolean;
  authenticated: boolean;
  imageGeneration: boolean;
  version?: string;
  errorCode?: CodexImageErrorCode;
  message?: string;
}

export interface CodexImageDraft {
  kind: CodexImageJobKind;
  status: "awaitingReview";
  asset: AssetDescriptorV1;
  deduplicated: boolean;
  revisedPrompt?: string;
}

export type CodexImageErrorCode =
  | "desktop_only"
  | "invalid_request"
  | "unavailable"
  | "unauthenticated"
  | "capability_unavailable"
  | "forbidden"
  | "busy"
  | "quota_exhausted"
  | "timeout"
  | "cancelled"
  | "unsafe_output"
  | "protocol_error"
  | "asset_import_failed"
  | "generation_failed";

const ERROR_CODES = new Set<CodexImageErrorCode>([
  "desktop_only",
  "invalid_request",
  "unavailable",
  "unauthenticated",
  "capability_unavailable",
  "forbidden",
  "busy",
  "quota_exhausted",
  "timeout",
  "cancelled",
  "unsafe_output",
  "protocol_error",
  "asset_import_failed",
  "generation_failed",
]);

export class CodexImageExecutorError extends Error {
  readonly code: CodexImageErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: CodexImageErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "CodexImageExecutorError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

interface CodexImageBackendResult {
  asset: unknown;
  deduplicated: unknown;
  revisedPrompt?: unknown;
}

export interface CodexImageExecutorDependencies {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  isDesktop: () => boolean;
}

const defaultDependencies: CodexImageExecutorDependencies = {
  invoke,
  isDesktop: () => typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined,
};

export class CodexImageExecutor {
  constructor(private readonly dependencies: CodexImageExecutorDependencies = defaultDependencies) {}

  async capabilities(authorization: CodexImageKeeperAuthorization): Promise<CodexImageCapabilities> {
    this.requireDesktop();
    const keeperAuthorization = validateKeeperAuthorization(authorization);
    try {
      return parseCapabilities(await this.dependencies.invoke("codex_image_capabilities", {
        authorization: keeperAuthorization,
      }));
    } catch (error) {
      throw parseExecutorError(error);
    }
  }

  /**
   * Generates one local draft and stops.  Binding it to an entity/board and
   * publishing it are intentionally separate, explicit review actions.
   */
  async generateDraft(
    input: CodexImageJob,
    authorization: CodexImageKeeperAuthorization,
  ): Promise<CodexImageDraft> {
    this.requireDesktop();
    const request = validateCodexImageJob(input);
    const keeperAuthorization = validateKeeperAuthorization(authorization);
    try {
      const raw = await this.dependencies.invoke("run_codex_image_job", {
        authorization: keeperAuthorization,
        request,
      });
      const result = parseBackendResult(raw);
      return {
        kind: request.kind,
        status: "awaitingReview",
        asset: result.asset,
        deduplicated: result.deduplicated,
        revisedPrompt: result.revisedPrompt,
      };
    } catch (error) {
      if (error instanceof CodexImageExecutorError) throw error;
      throw parseExecutorError(error);
    }
  }

  async cancel(authorization: CodexImageKeeperAuthorization): Promise<boolean> {
    this.requireDesktop();
    const keeperAuthorization = validateKeeperAuthorization(authorization);
    try {
      const result = await this.dependencies.invoke("cancel_codex_image_job", {
        authorization: keeperAuthorization,
      });
      if (typeof result !== "boolean") throw protocolError("Codex 图片取消响应格式无效。");
      return result;
    } catch (error) {
      if (error instanceof CodexImageExecutorError) throw error;
      throw parseExecutorError(error);
    }
  }

  private requireDesktop(): void {
    if (!this.dependencies.isDesktop()) {
      throw new CodexImageExecutorError(
        "desktop_only",
        "Codex 图片生成仅能在 CoC Room 桌面应用中运行。",
      );
    }
  }
}

export const codexImageExecutor = new CodexImageExecutor();

export function validateKeeperAuthorization(
  candidate: CodexImageKeeperAuthorization,
): CodexImageKeeperAuthorization {
  if (!isRecord(candidate)) throw invalidRequest("图片任务缺少房主授权上下文。");
  const keys = Object.keys(candidate);
  if (keys.length !== 2 || !keys.includes("roomId") || !keys.includes("seatId")) {
    throw invalidRequest("图片任务的房主授权上下文格式无效。");
  }
  if (typeof candidate.roomId !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(candidate.roomId)) {
    throw invalidRequest("图片任务的房间 ID 无效。");
  }
  if (typeof candidate.seatId !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(candidate.seatId)) {
    throw invalidRequest("图片任务的房主席位 ID 无效。");
  }
  return { roomId: candidate.roomId, seatId: candidate.seatId };
}

export function validateCodexImageJob(candidate: CodexImageJob): CodexImageJob {
  if (!isRecord(candidate)) throw invalidRequest("图片任务必须是对象。");
  const allowedKeys = new Set(["kind", "description", "style", "aspectRatio", "model"]);
  const unknownKey = Object.keys(candidate).find((key) => !allowedKeys.has(key));
  if (unknownKey) throw invalidRequest(`图片任务包含不允许的字段：${unknownKey}`);

  if (!CODEX_IMAGE_JOB_KINDS.includes(candidate.kind as CodexImageJobKind)) {
    throw invalidRequest("图片任务类型不受支持。");
  }
  const description = normalizeTextField(candidate.description, "画面描述", 4_000, false);
  const style = candidate.style === undefined
    ? undefined
    : normalizeTextField(candidate.style, "视觉风格", 500, true);
  const aspectRatio = candidate.aspectRatio ?? defaultAspectRatio(candidate.kind);
  if (!(["square", "landscape", "portrait"] as const).includes(aspectRatio)) {
    throw invalidRequest("图片宽高比不受支持。");
  }
  const model = candidate.model === undefined ? undefined : candidate.model.trim();
  if (model !== undefined && (model.length === 0 || model.length > 100 || !/^[A-Za-z0-9._-]+$/.test(model))) {
    throw invalidRequest("Codex 模型名称格式无效。");
  }

  return {
    kind: candidate.kind,
    description,
    ...(style === undefined ? {} : { style }),
    aspectRatio,
    ...(model === undefined ? {} : { model }),
  };
}

function parseCapabilities(candidate: unknown): CodexImageCapabilities {
  if (!isRecord(candidate)) throw protocolError("Codex 图片能力响应不是对象。");
  for (const key of ["installed", "compatible", "authenticated", "imageGeneration"] as const) {
    if (typeof candidate[key] !== "boolean") throw protocolError(`Codex 图片能力响应缺少 ${key}。`);
  }
  const result: CodexImageCapabilities = {
    installed: candidate.installed as boolean,
    compatible: candidate.compatible as boolean,
    authenticated: candidate.authenticated as boolean,
    imageGeneration: candidate.imageGeneration as boolean,
  };
  if (typeof candidate.version === "string") result.version = candidate.version;
  if (typeof candidate.errorCode === "string" && ERROR_CODES.has(candidate.errorCode as CodexImageErrorCode)) {
    result.errorCode = candidate.errorCode as CodexImageErrorCode;
  }
  if (typeof candidate.message === "string") result.message = candidate.message;
  return result;
}

function parseBackendResult(candidate: unknown): {
  asset: AssetDescriptorV1;
  deduplicated: boolean;
  revisedPrompt?: string;
} {
  if (!isRecord(candidate)) throw protocolError("Codex 图片结果不是对象。");
  if (typeof candidate.deduplicated !== "boolean") throw protocolError("Codex 图片结果缺少资源去重状态。");
  if (candidate.revisedPrompt !== undefined && typeof candidate.revisedPrompt !== "string") {
    throw protocolError("Codex 图片结果中的修订提示格式无效。");
  }
  let asset: AssetDescriptorV1;
  try {
    asset = assetDescriptorV1Schema.parse((candidate as unknown as CodexImageBackendResult).asset);
  } catch (error) {
    throw new CodexImageExecutorError("protocol_error", "Codex 图片结果中的资源描述符无效。", { cause: error });
  }
  const result: {
    asset: AssetDescriptorV1;
    deduplicated: boolean;
    revisedPrompt?: string;
  } = {
    asset,
    deduplicated: candidate.deduplicated,
  };
  if (typeof candidate.revisedPrompt === "string" && candidate.revisedPrompt.length > 0) {
    result.revisedPrompt = candidate.revisedPrompt;
  }
  return result;
}

function parseExecutorError(error: unknown): CodexImageExecutorError {
  if (error instanceof CodexImageExecutorError) return error;
  if (isRecord(error)) {
    const code = typeof error.code === "string" && ERROR_CODES.has(error.code as CodexImageErrorCode)
      ? error.code as CodexImageErrorCode
      : "generation_failed";
    const message = typeof error.message === "string" && error.message.trim().length > 0
      ? error.message
      : defaultErrorMessage(code);
    return new CodexImageExecutorError(code, message, {
      retryable: error.retryable === true,
      details: isRecord(error.details) ? error.details : undefined,
      cause: error,
    });
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return new CodexImageExecutorError("generation_failed", error, { cause: error });
  }
  return new CodexImageExecutorError("generation_failed", defaultErrorMessage("generation_failed"), { cause: error });
}

function normalizeTextField(value: unknown, label: string, maxCodePoints: number, allowEmpty: boolean): string {
  if (typeof value !== "string") throw invalidRequest(`${label}必须是文本。`);
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!allowEmpty && normalized.length === 0) throw invalidRequest(`${label}不能为空。`);
  if (/\u0000|[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(normalized)) {
    throw invalidRequest(`${label}包含不允许的控制字符。`);
  }
  if (Array.from(normalized).length > maxCodePoints) throw invalidRequest(`${label}超过 ${maxCodePoints} 个字符。`);
  return normalized;
}

function defaultAspectRatio(kind: CodexImageJobKind): CodexImageAspectRatio {
  if (kind === "npc" || kind === "character") return "portrait";
  if (kind === "location" || kind === "cover" || kind === "textlessMap") return "landscape";
  return "square";
}

function invalidRequest(message: string): CodexImageExecutorError {
  return new CodexImageExecutorError("invalid_request", message);
}

function protocolError(message: string): CodexImageExecutorError {
  return new CodexImageExecutorError("protocol_error", message);
}

function defaultErrorMessage(code: CodexImageErrorCode): string {
  switch (code) {
    case "desktop_only": return "Codex 图片生成仅能在桌面应用中运行。";
    case "invalid_request": return "图片任务参数无效。";
    case "unavailable": return "未找到兼容的 Codex App Server。";
    case "unauthenticated": return "Codex 尚未登录。";
    case "capability_unavailable": return "当前 Codex 提供者不支持图片生成。";
    case "forbidden": return "只有当前 V2 房间的房主可以使用 Codex 图片生成。";
    case "busy": return "已有 Codex 图片任务正在运行。";
    case "quota_exhausted": return "Codex 图片生成额度已用尽。";
    case "timeout": return "Codex 图片生成超时。";
    case "cancelled": return "Codex 图片生成已由房主停止。";
    case "unsafe_output": return "Codex 返回了不安全或无效的图片路径。";
    case "protocol_error": return "Codex App Server 返回了无效响应。";
    case "asset_import_failed": return "生成图片无法导入本地资源库。";
    case "generation_failed": return "Codex 图片生成失败。";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
