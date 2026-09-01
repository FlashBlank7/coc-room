const BRIDGE_PREFIX = "/__coc_room_local_ai/v1";
const BRIDGE_TOKEN_META = "coc-room-local-ai-token";
const BRIDGE_TOKEN_HEADER = "x-coc-room-local-ai";
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_BYTES = 1024 * 1024;
const MAX_MESSAGES = 100_000;

export type WebDevelopmentAiRoute =
  | "character-draft"
  | "npc-stats-draft"
  | "npc-reply"
  | "keeper-guide"
  | "image-generation"
  | "image-capabilities";

export type WebDevelopmentAiBridgeRunner = (
  route: WebDevelopmentAiRoute,
  request: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown[]>;

/**
 * Calls one of the three fixed, same-origin development operations. This is
 * deliberately not a configurable provider client: callers cannot supply a
 * URL, credential, command, path, timeout, executable, or tool declaration.
 */
export const runWebDevelopmentAiTask: WebDevelopmentAiBridgeRunner = async (
  route,
  request,
  signal,
) => {
  if (signal.aborted) throw abortReason(signal);
  const requestId = request.id;
  if (typeof requestId !== "string") throw new Error("本地 AI 请求 ID 无效");
  const sessionToken = readSessionToken();

  let response: Response;
  try {
    response = await fetch(`${BRIDGE_PREFIX}/${route}`, {
      method: "POST",
      mode: "same-origin",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: {
        "content-type": "application/json",
        [BRIDGE_TOKEN_HEADER]: sessionToken,
      },
      body: JSON.stringify(request),
      signal,
    });
  } catch {
    if (signal.aborted) throw abortReason(signal);
    throw new Error("无法连接本地 AI 开发桥");
  }

  if (!response.ok) {
    let code = "LOCAL_AI_BRIDGE_FAILED";
    try {
      const decoded = JSON.parse(await readBoundedUtf8(response, MAX_ERROR_BYTES));
      if (isRecord(decoded) && hasExactKeys(decoded, ["error"]) && isRecord(decoded.error)
        && hasExactKeys(decoded.error, ["code", "message"])
        && typeof decoded.error.code === "string"
        && /^[A-Z0-9_]{1,80}$/u.test(decoded.error.code)) {
        code = decoded.error.code;
      }
    } catch {
      // Never surface an arbitrary response body from the local process boundary.
    }
    throw new WebDevelopmentAiBridgeError(code, publicHttpErrorMessage(code));
  }

  let body: string;
  try {
    body = await readBoundedUtf8(response, MAX_RESPONSE_BYTES);
  } catch {
    if (signal.aborted) throw abortReason(signal);
    throw new Error("本地 AI 开发桥返回内容无效");
  }
  return validateNdjson(body, requestId, route);
};

export class WebDevelopmentAiBridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WebDevelopmentAiBridgeError";
  }
}

function readSessionToken(): string {
  const token = document.querySelector<HTMLMetaElement>(
    `meta[name="${BRIDGE_TOKEN_META}"]`,
  )?.content;
  if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new Error("当前页面没有可用的本地 AI 开发会话");
  }
  return token;
}

async function readBoundedUtf8(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw new Error("response exceeds fixed bridge limit");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function validateNdjson(
  body: string,
  requestId: string,
  route: WebDevelopmentAiRoute,
): unknown[] {
  if (!body || !body.endsWith("\n")) throw new Error("本地 AI 开发桥返回了截断的 JSONL");
  const lines = body.slice(0, -1).split("\n");
  if (lines.length < 1 || lines.length > MAX_MESSAGES || lines.some((line) => !line.trim())) {
    throw new Error("本地 AI 开发桥返回了非法 JSONL");
  }

  const messages = lines.map((line) => validateEnvelope(line, requestId, route));
  const terminals = messages.filter((message) => {
    const type = (message as Record<string, unknown>).type;
    return type === "result" || type === "error";
  });
  if (terminals.length !== 1 || messages[messages.length - 1] !== terminals[0]) {
    throw new Error("本地 AI 开发桥没有返回唯一终态");
  }
  return messages;
}

function validateEnvelope(
  line: string,
  requestId: string,
  route: WebDevelopmentAiRoute,
): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    throw new Error("本地 AI 开发桥返回了非法 JSONL");
  }
  if (!isRecord(decoded)
    || decoded.protocol_version !== "1.0"
    || decoded.request_id !== requestId
    || (decoded.type !== "progress" && decoded.type !== "result" && decoded.type !== "error")) {
    throw new Error("本地 AI 开发桥响应与当前请求不匹配");
  }
  if (decoded.type === "result") {
    if (!isRecord(decoded.result)) throw new Error("本地 AI 开发桥结果结构无效");
    return {
      protocol_version: "1.0",
      request_id: requestId,
      type: "result",
      result: decoded.result,
    };
  }
  if (decoded.type === "progress") {
    if (typeof decoded.stage !== "string" || decoded.stage.length > 100) {
      throw new Error("本地 AI 开发桥进度结构无效");
    }
    return {
      protocol_version: "1.0",
      request_id: requestId,
      type: "progress",
      stage: decoded.stage,
      message: "本地 AI 正在处理",
    };
  }

  const rawError = isRecord(decoded.error) ? decoded.error : undefined;
  const rawCode = rawError?.code;
  const code = typeof rawCode === "string" && /^[A-Z0-9_]{1,80}$/u.test(rawCode)
    ? rawCode
    : "LOCAL_AI_FAILED";
  const message = route === "character-draft"
    ? "角色草稿生成失败，未创建替代内容"
    : route === "npc-stats-draft"
      ? "NPC 属性草稿生成失败，未修改人物"
      : route === "image-generation"
        ? "图片生成失败，未产生草稿"
        : route === "image-capabilities"
          ? "图片能力探测失败"
          : "NPC 回复生成失败，未发布替代内容";
  return {
    protocol_version: "1.0",
    request_id: requestId,
    type: "error",
    message,
    error: { code, message, retryable: rawError?.retryable === true },
  };
}

function publicHttpErrorMessage(code: string): string {
  switch (code) {
    case "LOCAL_AI_BUSY": return "已有本地 AI 任务正在运行";
    case "DEEPSEEK_KEY_MISSING": return "请先在桌面设置中保存 DeepSeek Key";
    case "CODEX_NOT_FOUND": return "未找到本机 Codex CLI";
    case "CODEX_INCOMPATIBLE": return "本机 Codex CLI 版本不兼容";
    case "CODEX_LOGIN_REQUIRED": return "请先完成 Codex 登录";
    case "LOCAL_AI_TIMEOUT": return "本地 AI 任务已达到固定时间上限";
    case "PARSER_ENVIRONMENT_MISSING": return "本地 Python AI 环境尚未准备好";
    case "INVALID_BRIDGE_REQUEST": return "本地 AI 请求未通过安全校验";
    default: return "本地 AI 开发桥执行失败";
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("本地 AI 任务已取消", "AbortError");
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
