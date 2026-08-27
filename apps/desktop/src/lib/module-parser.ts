import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ModulePackageV1 } from "@coc-room/protocol";

export interface ParseModuleInput {
  sourceText?: string;
  sourcePath?: string;
  sourceName: string;
  model: string;
  mock?: boolean;
}

export interface ParserProgress {
  type: "progress";
  stage: string;
  message: string;
  progress?: number;
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

export interface ParserResult {
  type: "result";
  module: ModulePackageV1;
  normalizedText?: string;
  warnings?: string[];
  parseStatus?: string;
  issues?: ParserIssue[];
  usage?: ParserUsage;
}

export interface ParserError {
  type: "error";
  message: string;
  error?: { code?: string; message?: string; retryable?: boolean };
}

export type ParserMessage = ParserProgress | ParserResult | ParserError | Record<string, unknown>;

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
  if (!window.__TAURI_INTERNALS__) return false;
  return invoke<boolean>("has_deepseek_key");
}

export async function saveDeepseekKey(key: string): Promise<void> {
  if (!window.__TAURI_INTERNALS__) throw new Error("浏览器预览模式无法安全保存 API Key");
  await invoke("save_deepseek_key", { key });
}

export async function deleteDeepseekKey(): Promise<void> {
  if (window.__TAURI_INTERNALS__) await invoke("delete_deepseek_key");
}

export async function selectModuleSource(): Promise<string | undefined> {
  if (!window.__TAURI_INTERNALS__) return undefined;
  return (await invoke<string | null>("select_module_source")) ?? undefined;
}

export async function parseModule(
  input: ParseModuleInput,
  onProgress?: (progress: ParserProgress) => void,
): Promise<ParserMessage[]> {
  if (!window.__TAURI_INTERNALS__) {
    if (!input.mock) throw new Error("请在 Tauri 桌面应用中运行真实解析；浏览器预览仅支持模拟结果");
    return [withParserProvenance({
      type: "result",
      module: createMockModule(input.sourceName, input.sourceText ?? ""),
      warnings: ["浏览器预览生成的模拟模组"],
      parseStatus: "ready_for_review",
      issues: [],
      usage: { calls: 0 },
    }, input)];
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
        model: input.model,
        mock: input.mock ?? false,
      },
    });
    return messages.map((message) => isParserResult(message) ? withParserProvenance(message, input) : message);
  } finally {
    unlisten?.();
  }
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
    provider: input.mock ? "mock" : "deepseek",
    model: input.mock ? "builtin-mock" : input.model,
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
