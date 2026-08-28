// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModulePackageV1 } from "@coc-room/protocol";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import {
  getModuleParserProvenance,
  parseModule,
  PARSER_PROVENANCE_NAMESPACE,
  type ParserProgress,
  type ParserResult,
} from "./module-parser";

describe("module parser progress events", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
    mocks.unlisten.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  });

  it("streams only progress for the active request and removes its listener", async () => {
    let eventHandler: ((event: { payload: ParserProgress & { request_id?: string } }) => void) | undefined;
    mocks.listen.mockImplementation(async (_name, handler) => {
      eventHandler = handler;
      return mocks.unlisten;
    });
    mocks.invoke.mockImplementation(async (_command, args) => {
      const requestId = args.request.id as string;
      eventHandler?.({
        payload: { request_id: "another-request", type: "progress", stage: "ignored", message: "ignored" },
      });
      eventHandler?.({
        payload: { request_id: requestId, type: "progress", stage: "extract", message: "抽取实体", progress: 0.5 },
      });
      return [{ type: "progress", stage: "extract", message: "抽取实体", progress: 0.5 }];
    });
    const onProgress = vi.fn();

    const messages = await parseModule(
      { sourceText: "# 模组", sourceName: "module.md", provider: "deepseek", model: "deepseek-chat" },
      onProgress,
    );

    expect(messages).toHaveLength(1);
    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ stage: "extract", progress: 0.5 }));
    expect(mocks.invoke).toHaveBeenCalledWith("run_module_parser", {
      request: expect.objectContaining({ provider: "deepseek", model: "deepseek-chat" }),
    });
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });

  it("records Codex provenance and sends no model override when the field is blank", async () => {
    mocks.invoke.mockResolvedValue([{ type: "result", module: createModulePackage(), issues: [], usage: { calls: 1 } }]);

    const messages = await parseModule({
      sourceText: "# Codex 模组",
      sourceName: "codex.md",
      provider: "codex",
      model: "",
    });

    const result = messages[0] as ParserResult;
    expect(getModuleParserProvenance(result.module)).toMatchObject({
      provider: "codex",
      model: "codex-default",
      sourceName: "codex.md",
    });
    expect(mocks.invoke).toHaveBeenCalledWith("run_module_parser", {
      request: expect.objectContaining({ provider: "codex", model: "" }),
    });
  });

  it("records DeepSeek provenance while stripping source references from persisted issues", async () => {
    const sourceBody = "这段独特的原文正文不能进入解析来源元数据";
    mocks.invoke.mockResolvedValue([{
      type: "result",
      module: createModulePackage(),
      parseStatus: "needs_review",
      issues: [{
        severity: "warning",
        code: "UNRESOLVED_REFERENCE",
        stage: "resolve",
        message: "有一条引用需要人工修正",
        entity_id: "npc:missing",
        retryable: false,
        source_ref: { source_id: "source:1", start: 0, end: sourceBody.length, excerpt: sourceBody },
      }],
      usage: { inputTokens: 120, outputTokens: 45, calls: 2 },
    }]);

    const messages = await parseModule({
      sourceText: sourceBody,
      sourceName: "见世之蝶.md",
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    const result = messages[0] as ParserResult;
    const provenance = getModuleParserProvenance(result.module);

    expect(provenance).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sourceName: "见世之蝶.md",
      status: "needs_review",
      usage: { inputTokens: 120, outputTokens: 45, calls: 2 },
    });
    expect(Number.isNaN(Date.parse(provenance?.parsedAt ?? ""))).toBe(false);
    expect(provenance?.issues).toEqual([{
      severity: "warning",
      code: "UNRESOLVED_REFERENCE",
      stage: "resolve",
      message: "有一条引用需要人工修正",
      entityId: "npc:missing",
      retryable: false,
    }]);
    expect(JSON.stringify(provenance)).not.toContain(sourceBody);
    expect(result.module.extensions["org.example.existing"]).toEqual({ kept: true });
    expect(result.module.extensions[PARSER_PROVENANCE_NAMESPACE]).toBeDefined();
  });

  it("labels browser simulation as mock provenance with zero API calls", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: undefined });
    const sourceBody = "模拟解析的原文正文";

    const messages = await parseModule({
      sourceText: sourceBody,
      sourceName: "preview.md",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      mock: true,
    });
    const result = messages[0] as ParserResult;
    const provenance = getModuleParserProvenance(result.module);

    expect(provenance).toMatchObject({
      provider: "mock",
      model: "builtin-mock",
      sourceName: "preview.md",
      status: "ready_for_review",
      issues: [],
      usage: { calls: 0 },
    });
    expect(JSON.stringify(provenance)).not.toContain(sourceBody);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

function createModulePackage(): ModulePackageV1 {
  const timestamp = "2026-08-27T00:00:00.000Z";
  return {
    schemaVersion: 1,
    moduleId: "module_parser_provenance_01",
    revision: 1,
    metadata: {
      title: "解析来源测试模组",
      authors: [],
      language: "zh-CN",
      summary: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    overview: "",
    sourceDocuments: [],
    chapters: [],
    scenes: [],
    locations: [],
    npcs: [],
    clues: [],
    handouts: [],
    suggestedChecks: [],
    keeperNotes: [],
    relations: [],
    extensions: { "org.example.existing": { kept: true } },
  };
}
