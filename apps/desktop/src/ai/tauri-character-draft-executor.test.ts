import { afterEach, describe, expect, it, vi } from "vitest";

import { TauriCharacterDraftExecutor } from "./tauri-character-draft-executor";

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(async () => undefined as string | undefined),
  browserDraft: vi.fn(),
}));

vi.mock("../data/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/repository")>();
  return { ...actual, getRepository: async () => ({ getSetting: mocks.getSetting }) };
});

vi.mock("./browser-deepseek-character-draft", () => ({
  generateBrowserDeepSeekCharacterDraft: mocks.browserDraft,
}));

describe("TauriCharacterDraftExecutor", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "__TAURI_INTERNALS__");
    mocks.getSetting.mockReset();
    mocks.getSetting.mockResolvedValue(undefined);
    mocks.browserDraft.mockReset();
  });

  it("calls DeepSeek directly from the browser when a key is stored locally", async () => {
    Reflect.deleteProperty(globalThis, "__TAURI_INTERNALS__");
    mocks.getSetting.mockResolvedValue(" sk-browser ");
    mocks.browserDraft.mockResolvedValue({ name: "陈默" });
    const runWeb = vi.fn();
    const executor = new TauriCharacterDraftExecutor(vi.fn(), runWeb);
    const signal = new AbortController().signal;

    await expect(executor.executeCharacterDraft({ ...input(), provider: "deepseek" }, signal))
      .resolves.toEqual({ character: { name: "陈默" } });
    expect(runWeb).not.toHaveBeenCalled();
    expect(mocks.browserDraft).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "sk-browser",
      prompt: input().prompt,
      playerName: "玩家甲",
      ownerSeatId: "seat-player",
      signal,
    }));
  });

  it("falls back to the local bridge for DeepSeek when no browser key exists", async () => {
    Reflect.deleteProperty(globalThis, "__TAURI_INTERNALS__");
    const runWeb = vi.fn(async () => ([{ type: "result", result: { character: { name: "余弦" } } }]));
    const executor = new TauriCharacterDraftExecutor(vi.fn(), runWeb);

    await expect(executor.executeCharacterDraft({ ...input(), provider: "deepseek" }, new AbortController().signal))
      .resolves.toEqual({ name: "余弦" });
    expect(mocks.browserDraft).not.toHaveBeenCalled();
    expect(runWeb).toHaveBeenCalledOnce();
  });

  it("sends only the closed character-draft request", async () => {
    Object.defineProperty(globalThis, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const executor = new TauriCharacterDraftExecutor(async (command, args) => {
      calls.push({ command, args });
      return [{ type: "result", result: { character: { name: "余弦" } } }];
    });

    await expect(executor.executeCharacterDraft(input(), new AbortController().signal))
      .resolves.toEqual({ name: "余弦" });
    expect(calls[0]?.command).toBe("run_character_draft");
    expect(Object.keys(calls[0]?.args.request as Record<string, unknown>)).toEqual([
      "id", "action", "provider", "model", "prompt", "playerName", "ownerSeatId",
    ]);
    expect(JSON.stringify(calls[0])).not.toContain("path");
    expect(JSON.stringify(calls[0])).not.toContain("tools");
    expect(JSON.stringify(calls[0])).not.toContain("roomContext");
  });

  it("cancels the native process tree when the host coordinator aborts", async () => {
    Object.defineProperty(globalThis, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const commands: string[] = [];
    const executor = new TauriCharacterDraftExecutor((command) => {
      commands.push(command);
      if (command === "cancel_character_draft") return Promise.resolve(true);
      return new Promise(() => undefined);
    });
    const controller = new AbortController();
    const operation = executor.executeCharacterDraft(input(), controller.signal);
    controller.abort(new Error("stop"));

    await expect(operation).rejects.toThrow("stop");
    await Promise.resolve();
    expect(commands).toEqual(["run_character_draft", "cancel_character_draft"]);
  });

  it("does not turn provider errors into a fabricated character", async () => {
    Object.defineProperty(globalThis, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const executor = new TauriCharacterDraftExecutor(async () => ([{
      type: "error",
      error: { message: "possibly sensitive upstream error" },
    }]));
    await expect(executor.executeCharacterDraft(input(), new AbortController().signal))
      .rejects.toThrow("角色生成失败，请检查 AI 服务后重试。（LOCAL_AI_FAILED）");
  });

  it.each([
    ["CODEX_LOGIN_REQUIRED", "尚未登录"],
    ["MISSING_CREDENTIAL", "DeepSeek API Key"],
    ["INVALID_STRUCTURE", "角色资料格式不完整"],
    ["INTERNAL_ERROR", "INTERNAL_ERROR"],
  ])("explains %s without exposing provider details", async (code, expected) => {
    const runWeb = vi.fn(async () => [{ type: "error", error: { code, message: "PRIVATE_PROMPT_OR_CREDENTIAL" } }]);
    const executor = new TauriCharacterDraftExecutor(vi.fn(), runWeb);
    const error = await executor.executeCharacterDraft(input(), new AbortController().signal).catch((cause) => cause as Error);
    if (!(error instanceof Error)) throw new Error("Expected a failed character draft");
    expect(error.message).toContain(expected);
    expect(error.message).not.toContain("PRIVATE_PROMPT_OR_CREDENTIAL");
  });

  it("uses the fixed web-development action without exposing native controls", async () => {
    Reflect.deleteProperty(globalThis, "__TAURI_INTERNALS__");
    const invokeNative = vi.fn();
    const runWeb = vi.fn(async () => ([{ type: "result", result: { character: { name: "余弦" } } }]));
    const executor = new TauriCharacterDraftExecutor(invokeNative, runWeb);
    const signal = new AbortController().signal;

    await expect(executor.executeCharacterDraft(input(), signal)).resolves.toEqual({ name: "余弦" });
    expect(invokeNative).not.toHaveBeenCalled();
    expect(runWeb).toHaveBeenCalledWith("character-draft", {
      id: input().jobId,
      provider: "codex",
      model: "",
      prompt: input().prompt,
      playerName: "玩家甲",
      ownerSeatId: "seat-player",
    }, signal);
    expect(JSON.stringify(runWeb.mock.calls[0])).not.toMatch(/apiKey|path|command|tools|timeout|baseUrl|executable/i);
  });
});

function input() {
  return {
    jobId: "00000000-0000-4000-8000-000000000101",
    task: "character-draft" as const,
    provider: "codex" as const,
    model: "",
    prompt: "一位研究民俗的年轻记者",
    playerName: "玩家甲",
    ownerSeatId: "seat-player",
  };
}
