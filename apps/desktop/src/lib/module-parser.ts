import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ModulePackageV1 } from "@coc-room/protocol";

export interface ParseModuleInput {
  sourceText?: string;
  sourcePath?: string;
  /** Browser-only in-memory upload. It is sent to the same-origin Vite bridge and never persisted. */
  sourceFile?: File;
  sourceName: string;
  provider: "codex" | "deepseek";
  model: string;
  pdfVisualPageNumbers?: number[];
  mock?: boolean;
}

export interface CodexStatus {
  installed: boolean;
  compatible: boolean;
  authenticated: boolean;
  version?: string;
}

export interface LocalAiBridgeStatus {
  available: boolean;
  parserReady: boolean;
  deepseekKeyPresent: boolean;
  codex: CodexStatus;
}

const LOCAL_AI_BRIDGE_PREFIX = "/__coc_room_local_ai/v1";
const LOCAL_AI_BRIDGE_TOKEN_META = "coc-room-local-ai-token";

export interface ParserProgress {
  type: "progress";
  stage: string;
  message: string;
  progress?: number;
  details?: {
    event?: string;
    cli_phase?: string;
    codex_stage?: string;
    chunk_index?: number;
    chunk_count?: number;
    [key: string]: unknown;
  };
}

export function describeParserProgress(progress: ParserProgress): string {
  const details = progress.details;
  const position = typeof details?.chunk_index === "number" && typeof details.chunk_count === "number"
    ? `第 ${details.chunk_index + 1}/${details.chunk_count} 段`
    : "当前文本段";
  const material = details?.codex_stage === "world" ? "场景、地点与人物" : details?.codex_stage === "evidence" ? "线索、检定与手记" : "模组内容";
  if (typeof details?.event === "string" && details.event.startsWith("codex_")) {
    if (details.cli_phase === "starting") return `正在启动本机 Codex，准备处理${position}…`;
    if (details.cli_phase === "connected") return `已连接 Codex，正在提交${position}…`;
    if (details.cli_phase === "generating") return `Codex 正在从${position}整理${material}…`;
    if (details.cli_phase === "reported_error") return "Codex 暂未给出可用结果，正在等待明确的完成或失败状态…";
    if (details.cli_phase === "reconnecting") return "Codex 连接暂时中断，正在安全重连…";
    if (details.cli_phase === "completed") return `${position}的${material}已整理完成。`;
    if (details.cli_phase === "failed") return `Codex 未能完成${position}，正在整理可修复信息。`;
  }
  switch (progress.stage) {
    case "normalize": return "正在整理原文格式…";
    case "segment": return "正在把原文分成可核对的小段…";
    case "resolve_references": return "正在核对场景、人物与线索之间的引用…";
    case "validate": return "正在检查结构化模组是否完整…";
    case "summarize": return "正在汇总需要 KP 复核的内容…";
    case "pdf_vision": return "正在检查选中的 PDF 视觉页…";
    default: return progress.message || "正在处理模组…";
  }
}

export interface ParserIssue {
  severity?: string;
  code?: string;
  stage?: string;
  message?: string;
  entityId?: string;
  entity_id?: string;
  chunkId?: string;
  chunk_id?: string;
  retryable?: boolean;
  sourceRef?: unknown;
  source_ref?: unknown;
  [key: string]: unknown;
}

export interface ParserUsage {
  inputTokens?: number;
  outputTokens?: number;
  calls?: number;
}

export interface ParserSourceAttachment {
  kind: "image";
  sha256: string;
  mediaType: string;
  byteLength: number;
  width: number;
  height: number;
}

export interface ParserResult {
  type: "result";
  module: ModulePackageV1;
  normalizedText?: string;
  warnings?: string[];
  parseStatus?: string;
  issues?: ParserIssue[];
  usage?: ParserUsage;
  visualPages?: PdfVisualTranscript[];
  /** Validated, path-free metadata only. Attachment bytes are not returned by the text parser. */
  sourceAttachments?: ParserSourceAttachment[];
}

export interface PdfVisualPage {
  pageNumber: number;
  mediaType: "image/png";
  sha256: string;
  byteLength: number;
  width: number;
  height: number;
  dataBase64: string;
}

export interface PdfVisualTranscript {
  pageNumber: number;
  visibleText: string;
  visualDescription: string;
  sha256: string;
  byteLength: number;
  width: number;
  height: number;
}

export async function renderPdfPages(source: string | File, pageNumbers: number[]): Promise<PdfVisualPage[]> {
  if (!window.__TAURI_INTERNALS__) {
    if (!(source instanceof File)) throw new Error("网页开发模式需要重新选择 PDF 文件");
    const messages = await fetchBridgeMessages(`${LOCAL_AI_BRIDGE_PREFIX}/render-pdf-pages`, {
      id: crypto.randomUUID(),
      sourceFile: await fileToBridgeWire(source),
      pageNumbers,
    });
    const failure = messages.find(({ type }) => type === "error") as ParserError | undefined;
    if (failure) throw new Error(`${failure.error?.code ? `${failure.error.code}: ` : ""}${failure.message ?? "PDF 页面检查失败"}`);
    return (messages.find(({ type }) => type === "result") as { pages?: PdfVisualPage[] } | undefined)?.pages ?? [];
  }
  if (typeof source !== "string") throw new Error("桌面模式 PDF 页面检查需要已授权的本机路径");
  const messages = await invoke<Array<{ type: string; pages?: PdfVisualPage[]; message?: string; error?: { code?: string } }>>("run_module_parser", {
    request: { id: crypto.randomUUID(), action: "render_pdf_pages", source_path: source, page_numbers: pageNumbers },
  });
  const failure = messages.find(({ type }) => type === "error");
  if (failure) throw new Error(`${failure.error?.code ? `${failure.error.code}: ` : ""}${failure.message ?? "PDF 页面检查失败"}`);
  return messages.find(({ type }) => type === "result")?.pages ?? [];
}

export interface ParserError {
  type: "error";
  message: string;
  error?: { code?: string; message?: string; retryable?: boolean };
}

export function describeParserFailure(failure: ParserError): string {
  switch (failure.error?.code) {
    case "CODEX_NETWORK_UNAVAILABLE":
      return "Codex 暂时无法连接服务。请检查网络后重试；本次没有生成或保存空白模组。";
    case "CODEX_CLI_STALLED":
      return "Codex 持续没有返回新状态，任务已安全停止。本次结果未保存，请稍后再试。";
    case "CODEX_TIMEOUT":
      return "Codex 在限定时间内没有完成解析。本次结果未保存，可以缩小输入或稍后重试。";
    case "CODEX_TURN_FAILED":
      return "Codex 没有完成这次解析。本次结果未保存，请稍后重试。";
    case "CODEX_NOT_AUTHENTICATED":
      return "Codex 尚未登录。请先在终端运行 codex login，再回来重试。";
    case "CODEX_NOT_FOUND":
      return "没有找到可用的 Codex CLI。请先安装并登录 Codex。";
    case "DEEPSEEK_KEY_MISSING":
      return "尚未配置 DeepSeek Key。请先在终端运行 pnpm ai:key:set。";
    default:
      return failure.message || failure.error?.message || "模组解析失败，本次结果未保存。";
  }
}

export type ParserMessage = ParserProgress | ParserResult | ParserError | Record<string, unknown>;

export class ModuleParserCancelledError extends Error {
  constructor() {
    super("模组整理已停止");
    this.name = "AbortError";
  }
}

export const PARSER_PROVENANCE_NAMESPACE = "org.coc-room.parser";

export interface ModuleParserProvenanceIssue {
  severity?: string;
  code?: string;
  stage?: string;
  message?: string;
  entityId?: string;
  chunkId?: string;
  retryable?: boolean;
}

export interface ModuleParserProvenance {
  provider: string;
  model: string;
  parsedAt: string;
  sourceName: string;
  status: string;
  issues: ModuleParserProvenanceIssue[];
  usage: ParserUsage;
}

export async function hasDeepseekKey(): Promise<boolean> {
  if (!window.__TAURI_INTERNALS__) {
    try { return (await getLocalAiBridgeStatus()).deepseekKeyPresent; }
    catch { return false; }
  }
  return invoke<boolean>("has_deepseek_key");
}

export async function saveDeepseekKey(key: string): Promise<void> {
  if (!window.__TAURI_INTERNALS__) throw new Error("网页不会接收 API Key；请在终端运行 pnpm ai:key:set");
  await invoke("save_deepseek_key", { key });
}

export async function deleteDeepseekKey(): Promise<void> {
  if (window.__TAURI_INTERNALS__) await invoke("delete_deepseek_key");
}

export async function getCodexStatus(): Promise<CodexStatus> {
  if (!window.__TAURI_INTERNALS__) {
    try { return (await getLocalAiBridgeStatus()).codex; }
    catch { return { installed: false, compatible: false, authenticated: false }; }
  }
  return invoke<CodexStatus>("codex_status");
}

export async function getLocalAiBridgeStatus(): Promise<LocalAiBridgeStatus> {
  if (window.__TAURI_INTERNALS__) {
    return {
      available: true,
      parserReady: true,
      deepseekKeyPresent: await invoke<boolean>("has_deepseek_key"),
      codex: await invoke<CodexStatus>("codex_status"),
    };
  }
  const response = await fetch(`${LOCAL_AI_BRIDGE_PREFIX}/status`, {
    method: "POST",
    headers: localAiBridgeHeaders(),
    body: "{}",
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw await bridgeResponseError(response);
  return await response.json() as LocalAiBridgeStatus;
}

export async function selectModuleSource(): Promise<string | undefined> {
  if (!window.__TAURI_INTERNALS__) return undefined;
  return (await invoke<string | null>("select_module_source")) ?? undefined;
}

export async function parseModule(
  input: ParseModuleInput,
  onProgress?: (progress: ParserProgress) => void,
  signal?: AbortSignal,
): Promise<ParserMessage[]> {
  throwIfModuleParserCancelled(signal);
  if (!window.__TAURI_INTERNALS__) {
    if (input.mock) {
      return [withParserProvenance({
        type: "result",
        module: createMockModule(input.sourceName, input.sourceText ?? ""),
        warnings: ["浏览器预览生成的模拟模组"],
        parseStatus: "ready_for_review",
        issues: [],
        usage: { calls: 0 },
      }, input)];
    }
    if (input.sourcePath) throw new Error("网页开发模式不接受本机路径；请通过文件选择器重新选择模组");
    const sourceFile = input.sourceFile ? await fileToBridgeWire(input.sourceFile, signal) : undefined;
    throwIfModuleParserCancelled(signal);
    let messages: ParserMessage[];
    try {
      messages = await fetchBridgeMessages(`${LOCAL_AI_BRIDGE_PREFIX}/parse-module`, {
        id: crypto.randomUUID(),
        sourceText: input.sourceText,
        sourceFile,
        sourceName: input.sourceName,
        provider: input.provider,
        model: input.model,
        pdfVisualPageNumbers: input.pdfVisualPageNumbers,
        mock: false,
      }, onProgress, signal);
    } catch (cause) {
      if (signal?.aborted || isAbortLike(cause)) throw new ModuleParserCancelledError();
      throw cause;
    }
    throwIfModuleParserCancelled(signal);
    return messages.map((message) => isParserResult(message) ? withParserProvenance(message, input) : message);
  }
  const requestId = crypto.randomUUID();
  let unlisten: UnlistenFn | undefined;
  if (onProgress) {
    unlisten = await listen<ParserProgress & { request_id?: string }>("module-parser-progress", (event) => {
      if (event.payload.request_id === requestId && event.payload.type === "progress") {
        onProgress(event.payload);
      }
    });
  }
  try {
    const messages = await invoke<ParserMessage[]>("run_module_parser", {
      request: {
        id: requestId,
        action: "parse_module",
        source_text: input.sourceText,
        source_path: input.sourcePath,
        source_name: input.sourceName,
        provider: input.provider,
        model: input.model,
        pdf_visual_page_numbers: input.mock ? undefined : input.pdfVisualPageNumbers,
        mock: input.mock ?? false,
      },
    });
    return messages.map((message) => isParserResult(message) ? withParserProvenance(message, input) : message);
  } finally {
    unlisten?.();
  }
}

async function fileToBridgeWire(file: File, signal?: AbortSignal): Promise<{ name: string; byteLength: number; sha256: string; dataBase64: string }> {
  throwIfModuleParserCancelled(signal);
  const extension = file.name.toLowerCase().match(/\.[^.]+$/u)?.[0] ?? "";
  const maximum = extension === ".pdf" ? 50 * 1024 * 1024 : 25 * 1024 * 1024;
  if (file.size < 1 || file.size > maximum) throw new Error(`模组文件为空或超过 ${maximum / 1024 / 1024} MiB 上限`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    throwIfModuleParserCancelled(signal);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    throwIfModuleParserCancelled(signal);
    const sha256 = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
      throwIfModuleParserCancelled(signal);
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    }
    return { name: file.name, byteLength: bytes.byteLength, sha256, dataBase64: btoa(binary) };
  } finally {
    bytes.fill(0);
  }
}

async function fetchBridgeMessages(
  route: string,
  payload: Record<string, unknown>,
  onProgress?: (progress: ParserProgress) => void,
  signal?: AbortSignal,
): Promise<ParserMessage[]> {
  let response: Response;
  try {
    response = await fetch(route, {
      method: "POST",
      headers: localAiBridgeHeaders(),
      body: JSON.stringify(payload),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
  } catch (cause) {
    if (signal?.aborted || isAbortLike(cause)) throw new ModuleParserCancelledError();
    throw new Error("无法连接本地 AI 桥；请确认当前页面由 pnpm dev 启动");
  }
  if (!response.ok) throw await bridgeResponseError(response);
  if (!response.body) throw new Error("本地 AI 桥没有返回响应流");

  const messages: ParserMessage[] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line) as ParserMessage;
        messages.push(message);
        if (message.type === "progress") onProgress?.(message as ParserProgress);
      }
      newline = pending.indexOf("\n");
    }
    if (done) break;
  }
  if (pending.trim()) throw new Error("本地 AI 桥返回了截断的 JSONL");
  if (messages.length === 0) throw new Error("本地 AI 桥没有返回解析结果");
  return messages;
}

function throwIfModuleParserCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ModuleParserCancelledError();
}

function isAbortLike(value: unknown): boolean {
  return typeof value === "object" && value !== null && "name" in value && value.name === "AbortError";
}

function localAiBridgeHeaders(): Record<string, string> {
  const token = document.querySelector<HTMLMetaElement>(
    `meta[name="${LOCAL_AI_BRIDGE_TOKEN_META}"]`,
  )?.content;
  if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new Error("当前页面没有本地 AI 桥开发会话；请通过 pnpm dev 打开页面并刷新");
  }
  return {
    "Content-Type": "application/json",
    "x-coc-room-local-ai": token,
  };
}

async function bridgeResponseError(response: Response): Promise<Error> {
  try {
    const payload = await response.json() as { error?: { code?: string; message?: string } };
    const code = payload.error?.code;
    const message = payload.error?.message;
    if (message) return new Error(`${code ? `${code}: ` : ""}${message}`);
  } catch {
    // The bridge intentionally returns no server diagnostics to the browser.
  }
  return new Error(`本地 AI 桥请求失败（HTTP ${response.status}）`);
}

export function getModuleParserProvenance(modulePackage: ModulePackageV1): ModuleParserProvenance | undefined {
  const value = modulePackage.extensions[PARSER_PROVENANCE_NAMESPACE];
  if (!isRecord(value)) return undefined;
  if (
    typeof value.provider !== "string"
    || typeof value.model !== "string"
    || typeof value.parsedAt !== "string"
    || typeof value.sourceName !== "string"
    || typeof value.status !== "string"
  ) return undefined;

  return {
    provider: value.provider,
    model: value.model,
    parsedAt: value.parsedAt,
    sourceName: value.sourceName,
    status: value.status,
    issues: Array.isArray(value.issues) ? value.issues.map(sanitizeIssue).filter(isDefined) : [],
    usage: sanitizeUsage(value.usage),
  };
}

function withParserProvenance(result: ParserResult, input: ParseModuleInput): ParserResult {
  const issues = (result.issues ?? []).map(sanitizeIssue).filter(isDefined);
  const status = result.parseStatus
    ?? (issues.some((issue) => issue.severity === "error" || issue.severity === "warning") ? "needs_review" : "ready_for_review");
  const provenance: ModuleParserProvenance = {
    provider: input.mock ? "mock" : input.provider,
    model: input.mock ? "builtin-mock" : (input.model || "codex-default"),
    parsedAt: new Date().toISOString(),
    sourceName: input.sourceName,
    status,
    issues,
    usage: sanitizeUsage(result.usage),
  };
  return {
    ...result,
    module: {
      ...result.module,
      extensions: {
        ...result.module.extensions,
        [PARSER_PROVENANCE_NAMESPACE]: provenance,
      },
    },
  };
}

function sanitizeIssue(value: unknown): ModuleParserProvenanceIssue | undefined {
  if (!isRecord(value)) return undefined;
  const issue: ModuleParserProvenanceIssue = {};
  if (typeof value.severity === "string") issue.severity = value.severity;
  if (typeof value.code === "string") issue.code = value.code;
  if (typeof value.stage === "string") issue.stage = value.stage;
  if (typeof value.message === "string") issue.message = value.message;
  const entityId = typeof value.entityId === "string" ? value.entityId : value.entity_id;
  const chunkId = typeof value.chunkId === "string" ? value.chunkId : value.chunk_id;
  if (typeof entityId === "string") issue.entityId = entityId;
  if (typeof chunkId === "string") issue.chunkId = chunkId;
  if (typeof value.retryable === "boolean") issue.retryable = value.retryable;
  return issue;
}

function sanitizeUsage(value: unknown): ParserUsage {
  if (!isRecord(value)) return {};
  const usage: ParserUsage = {};
  if (isNonNegativeFiniteNumber(value.inputTokens)) usage.inputTokens = value.inputTokens;
  if (isNonNegativeFiniteNumber(value.outputTokens)) usage.outputTokens = value.outputTokens;
  if (isNonNegativeFiniteNumber(value.calls)) usage.calls = value.calls;
  return usage;
}

function isParserResult(message: ParserMessage): message is ParserResult {
  return message.type === "result" && isRecord(message.module);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function createMockModule(title: string, sourceText: string): ModulePackageV1 {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  return {
    schemaVersion: 1,
    moduleId: id,
    revision: 1,
    metadata: { title: title || "未命名模组", authors: [], language: "zh-CN", summary: sourceText.slice(0, 240), createdAt: now, updatedAt: now },
    overview: sourceText.slice(0, 2_000),
    sourceDocuments: [{ id: `source-${id}`, name: title || "pasted-text.md", mediaType: "text/markdown" }],
    chapters: [], scenes: [], locations: [], npcs: [], clues: [], handouts: [], suggestedChecks: [], keeperNotes: [], relations: [], extensions: {},
  };
}
