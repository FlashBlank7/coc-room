// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import { parseModule, type ParserProgress } from "./module-parser";

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
      { sourceText: "# 模组", sourceName: "module.md", model: "deepseek-chat" },
      onProgress,
    );

    expect(messages).toHaveLength(1);
    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ stage: "extract", progress: 0.5 }));
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });
});
