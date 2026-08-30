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
  ModuleParserCancelledError,
  parseModule,
  describeParserFailure,
  describeParserProgress,
  renderPdfPages,
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

  it("turns Codex protocol phases into keeper-facing progress", () => {
    expect(describeParserProgress({
      type: "progress",
      stage: "extract",
      message: "Waiting for Codex on world stage for chunk 2/4",
      details: {
        event: "codex_waiting",
        cli_phase: "generating",
        codex_stage: "world",
        chunk_index: 1,
        chunk_count: 4,
      },
    })).toBe("Codex 正在从第 2/4 段整理场景、地点与人物…");
    expect(describeParserProgress({
      type: "progress",
      stage: "extract",
      message: "provider retry",
      details: { event: "codex_waiting", cli_phase: "reported_error" },
    })).toBe("Codex 暂未给出可用结果，正在等待明确的完成或失败状态…");
    expect(describeParserProgress({
      type: "progress",
      stage: "extract",
      message: "legacy reconnect",
      details: { event: "codex_waiting", cli_phase: "reconnecting" },
    })).toBe("Codex 连接暂时中断，正在安全重连…");
    expect(describeParserProgress({
      type: "progress",
      stage: "resolve_references",
      message: "Resolving entity references",
    })).toBe("正在核对场景、人物与线索之间的引用…");
  });

  it("turns provider codes into actionable errors without technical leakage", () => {
    expect(describeParserFailure({
      type: "error",
      message: "Codex network remained unavailable: private detail",
      error: { code: "CODEX_NETWORK_UNAVAILABLE" },
    })).toBe("Codex 暂时无法连接服务。请检查网络后重试；本次没有生成或保存空白模组。");
    expect(describeParserFailure({
      type: "error",
      message: "private provider and module detail",
      error: { code: "CODEX_CLI_STALLED" },
    })).toBe("Codex 持续没有返回新状态，任务已安全停止。本次结果未保存，请稍后再试。");
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

  it("requests an explicit bounded PDF visual page selection", async () => {
    mocks.invoke.mockResolvedValue([{ type: "result", pages: [{ pageNumber: 2, mediaType: "image/png", sha256: "a".repeat(64), byteLength: 8, width: 10, height: 20, dataBase64: "iVBORw0KGgo=" }] }]);
    const pages = await renderPdfPages("C:\\module.pdf", [2]);
    expect(pages[0]?.pageNumber).toBe(2);
    expect(mocks.invoke).toHaveBeenCalledWith("run_module_parser", { request: expect.objectContaining({ action: "render_pdf_pages", source_path: "C:\\module.pdf", page_numbers: [2] }) });
  });

  it("passes reviewed PDF pages to live Codex parsing but never to mock parsing", async () => {
    mocks.invoke.mockResolvedValue([{ type: "result", module: createModulePackage() }]);

    await parseModule({
      sourcePath: "C:\\module.pdf",
      sourceName: "module.pdf",
      provider: "codex",
      model: "",
      pdfVisualPageNumbers: [2, 4],
    });
    expect(mocks.invoke).toHaveBeenLastCalledWith("run_module_parser", {
      request: expect.objectContaining({ pdf_visual_page_numbers: [2, 4] }),
    });

    await parseModule({
      sourcePath: "C:\\module.pdf",
      sourceName: "module.pdf",
      provider: "codex",
      model: "",
      pdfVisualPageNumbers: [2, 4],
      mock: true,
    });
    expect(mocks.invoke).toHaveBeenLastCalledWith("run_module_parser", {
      request: expect.objectContaining({ pdf_visual_page_numbers: undefined }),
    });
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

describe("module parser web development bridge", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: undefined });
    document.head.innerHTML = '<meta name="coc-room-local-ai-token" content="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">';
    vi.unstubAllGlobals();
  });

  it("refuses to contact the bridge when the Vite development-session token is absent", async () => {
    document.head.innerHTML = "";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { getLocalAiBridgeStatus } = await import("./module-parser");

    await expect(getLocalAiBridgeStatus()).rejects.toThrow("没有本地 AI 桥开发会话");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams a real browser parse through the same-origin allowlisted bridge", async () => {
    const progress = { request_id: "server-normalizes-id", type: "progress", stage: "extract", message: "正在抽取", progress: 0.5 };
    const result = { request_id: "server-normalizes-id", type: "result", module: createModulePackage(), issues: [], usage: { calls: 1 } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(`${JSON.stringify(progress)}\n${JSON.stringify(result)}\n`, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onProgress = vi.fn();

    const messages = await parseModule({
      sourceText: "# 网页桥模组",
      sourceName: "bridge.md",
      provider: "codex",
      model: "",
    }, onProgress);

    expect(messages).toHaveLength(2);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ stage: "extract", progress: 0.5 }));
    expect(fetchMock).toHaveBeenCalledWith("/__coc_room_local_ai/v1/parse-module", expect.objectContaining({
      method: "POST",
      credentials: "omit",
      headers: expect.objectContaining({
        "x-coc-room-local-ai": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    }));
    const requestBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as Record<string, unknown>;
    expect(requestBody).toMatchObject({ sourceText: "# 网页桥模组", provider: "codex" });
    expect(requestBody).not.toHaveProperty("apiKey");
    expect(requestBody).not.toHaveProperty("sourcePath");
  });

  it("passes cancellation to the bridge fetch and rejects a result that arrives after stopping", async () => {
    const result = { request_id: "late-result", type: "result", module: createModulePackage(), issues: [], usage: { calls: 1 } };
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn().mockImplementation((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const operation = parseModule({
      sourceText: "# 已停止的网页模组",
      sourceName: "cancelled.md",
      provider: "codex",
      model: "",
    }, undefined, controller.signal);
    controller.abort();
    resolveFetch?.(new Response(`${JSON.stringify(result)}\n`, { status: 200 }));

    await expect(operation).rejects.toBeInstanceOf(ModuleParserCancelledError);
    expect(fetchMock).toHaveBeenCalledWith("/__coc_room_local_ai/v1/parse-module", expect.objectContaining({
      signal: controller.signal,
    }));
  });

  it("does not rewrite an aborted bridge fetch as a connection failure", async () => {
    const fetchMock = vi.fn().mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const aborted = new Error("native fetch aborted");
        aborted.name = "AbortError";
        reject(aborted);
      }, { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const operation = parseModule({
      sourceText: "# 主动停止",
      sourceName: "abort.md",
      provider: "codex",
      model: "",
    }, undefined, controller.signal);

    controller.abort();

    await expect(operation).rejects.toBeInstanceOf(ModuleParserCancelledError);
    await expect(operation).rejects.not.toThrow("无法连接本地 AI 桥");
  });

  it("uploads a DOCX as an integrity-checked in-memory file without exposing a local path", async () => {
    const bytes = new TextEncoder().encode("fake-docx-for-wire-boundary");
    const file = new File([bytes], "scenario.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    const result = { request_id: "wire-file", type: "result", module: createModulePackage(), issues: [] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(`${JSON.stringify(result)}\n`, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await parseModule({
      sourceFile: file,
      sourceName: file.name,
      provider: "codex",
      model: "",
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      sourceFile: { name: string; byteLength: number; sha256: string; dataBase64: string };
    };
    expect(requestBody.sourceFile).toMatchObject({
      name: "scenario.docx",
      byteLength: bytes.byteLength,
      dataBase64: btoa(String.fromCharCode(...bytes)),
    });
    expect(requestBody.sourceFile.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(requestBody).not.toHaveProperty("sourcePath");
    expect(JSON.stringify(requestBody)).not.toContain("F:\\");
  });

  it("reads only credential presence and Codex status from the bridge status route", async () => {
    const status = {
      available: true,
      parserReady: true,
      deepseekKeyPresent: true,
      codex: { installed: true, compatible: true, authenticated: true, version: "codex-cli test" },
    };
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(status), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { getLocalAiBridgeStatus, hasDeepseekKey, getCodexStatus } = await import("./module-parser");
    await expect(getLocalAiBridgeStatus()).resolves.toEqual(status);
    await expect(hasDeepseekKey()).resolves.toBe(true);
    await expect(getCodexStatus()).resolves.toEqual(status.codex);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("apiKey");
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
