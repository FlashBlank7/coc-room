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

export interface ParserResult {
  type: "result";
  module: ModulePackageV1;
  normalizedText?: string;
  warnings?: string[];
  usage?: { inputTokens?: number; outputTokens?: number; calls?: number };
}

export interface ParserError {
  type: "error";
  message: string;
  error?: { code?: string; message?: string; retryable?: boolean };
}

export type ParserMessage = ParserProgress | ParserResult | ParserError | Record<string, unknown>;

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
    return [{ type: "result", module: createMockModule(input.sourceName, input.sourceText ?? ""), warnings: ["浏览器预览生成的模拟模组"] }];
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
    return await invoke<ParserMessage[]>("run_module_parser", {
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
  } finally {
    unlisten?.();
  }
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
