/**
 * Shared browser→DeepSeek call for pages without a local AI channel. The API
 * allows cross-origin browser requests, so the keeper's key — stored only in
 * this browser — travels straight to api.deepseek.com and nowhere else. The
 * payload shape mirrors the Python sidecar providers so both paths behave
 * identically.
 */

export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";

export class BrowserDeepSeekError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = "BrowserDeepSeekError";
  }
}

export interface BrowserDeepSeekCallOptions {
  apiKey: string;
  model?: string;
  instructions: string;
  /** Compact JSON string; the complete and only story data sent upstream. */
  inputJson: string;
  schemaName: string;
  /** Strict JSON schema for the structured output. */
  schema: unknown;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/** Runs one structured-output request and returns the parsed JSON object. */
export async function callBrowserDeepSeek(options: BrowserDeepSeekCallOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? "https://api.deepseek.com").replace(/\/$/, "");
  const model = options.model?.trim() || DEFAULT_DEEPSEEK_MODEL;

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: options.signal ?? null,
      body: JSON.stringify({
        model,
        instructions: options.instructions,
        input: options.inputJson,
        reasoning: { effort: "none" },
        max_output_tokens: options.maxOutputTokens ?? 8_192,
        stream: false,
        tools: [],
        tool_choice: "none",
        text: {
          format: {
            type: "json_schema",
            name: options.schemaName,
            schema: options.schema,
          },
        },
      }),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new BrowserDeepSeekError("无法连接 DeepSeek（浏览器直连）。请检查网络后重试。", true);
  }
  if (response.status === 401 || response.status === 403) {
    throw new BrowserDeepSeekError("DeepSeek 拒绝了这个 API Key，请在设置里检查后重新保存。");
  }
  if (response.status >= 400) {
    const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
    const detail = await response.text().then((text) => text.slice(0, 300)).catch(() => "");
    throw new BrowserDeepSeekError(`DeepSeek 返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`, retryable);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new BrowserDeepSeekError("DeepSeek 返回了非 JSON 响应");
  }
  return parseProviderPayload(body);
}

/** Accepts both Responses-style bodies and a bare chat-completions fallback. */
function parseProviderPayload(body: unknown): unknown {
  if (!isRecord(body)) throw new BrowserDeepSeekError("DeepSeek 响应结构无效");
  if (body.status === "incomplete") throw new BrowserDeepSeekError("DeepSeek 响应被截断，请重试", true);
  if (body.status === "failed" || body.error) throw new BrowserDeepSeekError("DeepSeek 响应失败，请重试", true);
  const outputs: string[] = [];
  if (typeof body.output_text === "string") outputs.push(body.output_text);
  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      if (!isRecord(item) || item.type !== "message") continue;
      if (item.status === "incomplete") throw new BrowserDeepSeekError("DeepSeek 响应被截断，请重试", true);
      if (!Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") {
          outputs.push(content.text);
        }
      }
    }
  }
  if (outputs.length === 0 && Array.isArray(body.choices)) {
    for (const choice of body.choices) {
      const message = isRecord(choice) ? choice.message : undefined;
      if (isRecord(message) && typeof message.content === "string") outputs.push(message.content);
    }
  }
  let raw = outputs.join("").trim();
  if (raw.length === 0) throw new BrowserDeepSeekError("DeepSeek 没有返回内容");
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new BrowserDeepSeekError("DeepSeek 返回了无法解析的 JSON", true);
  }
}

/** Shared copy for a DeepSeek task that has neither a stored key nor a bridge. */
export const DEEPSEEK_KEY_MISSING_MESSAGE =
  "要在网页端使用 DeepSeek，请先到 设置 → AI 文字服务(DeepSeek) 保存 API Key。";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
