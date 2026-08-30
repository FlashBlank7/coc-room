import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TauriNpcStatsDraftExecutor,
  validateNpcStatsDraftRequest,
  type NpcStatsDraftRequestV1,
} from "./tauri-npc-stats-draft-executor";

describe("TauriNpcStatsDraftExecutor", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "__TAURI_INTERNALS__");
  });

  it("sends only the closed host-local NPC stats request", async () => {
    Object.defineProperty(globalThis, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const executor = new TauriNpcStatsDraftExecutor(async (command, args) => {
      calls.push({ command, args });
      return [result()];
    });

    await expect(executor.generateDraft(input(), new AbortController().signal)).resolves.toEqual({
      npcId: "npc:watchman",
      provider: "codex",
      model: "",
      character: {
        characteristics: { str: 60, con: 50, siz: 55, dex: 65, int: 70, pow: 50 },
        skills: { Stealth: 55 },
        hitPoints: 10,
        sanity: 50,
      },
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error("expected native invocation");
    expect(call.command).toBe("run_npc_stats_draft");
    const request = call.args.request as Record<string, unknown>;
    expect(Object.keys(request)).toEqual([
      "id", "action", "provider", "model", "npcId", "name", "description", "guidance",
    ]);
    expect(request.action).toBe("generate_npc_stats_draft");
    expect(JSON.stringify(request)).not.toMatch(/path|tools|roomContext|module|url/i);
  });

  it("rejects proxy fields before invoking native code", async () => {
    Object.defineProperty(globalThis, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const invoke = vi.fn();
    const executor = new TauriNpcStatsDraftExecutor(invoke);
    const unsafe = { ...input(), tools: ["shell"] } as NpcStatsDraftRequestV1;

    await expect(executor.generateDraft(unsafe, new AbortController().signal))
      .rejects.toThrow("未授权字段");
    expect(invoke).not.toHaveBeenCalled();
    expect(() => validateNpcStatsDraftRequest({ ...input(), sourcePath: "C:/secret" } as NpcStatsDraftRequestV1))
      .toThrow("未授权字段");
  });

  it("cancels the native process tree when the local review task is aborted", async () => {
    Object.defineProperty(globalThis, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const commands: string[] = [];
    const executor = new TauriNpcStatsDraftExecutor((command) => {
      commands.push(command);
      if (command === "cancel_npc_stats_draft") return Promise.resolve(true);
      return new Promise(() => undefined);
    });
    const controller = new AbortController();
    const operation = executor.generateDraft(input(), controller.signal);
    controller.abort(new Error("stop"));

    await expect(operation).rejects.toThrow("stop");
    await Promise.resolve();
    expect(commands).toEqual(["run_npc_stats_draft", "cancel_npc_stats_draft"]);
  });

  it("rejects mismatched targets, invalid stats, and provider errors", async () => {
    Object.defineProperty(globalThis, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const mismatch = new TauriNpcStatsDraftExecutor(async () => [
      { ...result(), result: { ...result().result, npcId: "npc:other" } },
    ]);
    await expect(mismatch.generateDraft(input(), new AbortController().signal))
      .rejects.toThrow("不匹配");

    const invalid = new TauriNpcStatsDraftExecutor(async () => [
      { ...result(), result: { ...result().result, character: { ...result().result.character, hitPoints: 100 } } },
    ]);
    await expect(invalid.generateDraft(input(), new AbortController().signal))
      .rejects.toThrow("HP 无效");

    const failed = new TauriNpcStatsDraftExecutor(async () => [
      { type: "error", error: { message: "sensitive upstream detail" } },
    ]);
    await expect(failed.generateDraft(input(), new AbortController().signal))
      .rejects.toThrow("提供者失败");
  });

  it("uses the fixed web-development action with an exact browser payload", async () => {
    Reflect.deleteProperty(globalThis, "__TAURI_INTERNALS__");
    const invokeNative = vi.fn();
    const runWeb = vi.fn(async () => [result()]);
    const executor = new TauriNpcStatsDraftExecutor(invokeNative, runWeb);
    const signal = new AbortController().signal;

    await expect(executor.generateDraft(input(), signal)).resolves.toMatchObject({ npcId: "npc:watchman" });
    expect(invokeNative).not.toHaveBeenCalled();
    expect(runWeb).toHaveBeenCalledOnce();
    const [route, payload, receivedSignal] = (runWeb.mock.calls[0] ?? []) as unknown as [
      string,
      Record<string, unknown>,
      AbortSignal,
    ];
    expect(route).toBe("npc-stats-draft");
    expect(Object.keys(payload)).toEqual([
      "id", "provider", "model", "npcId", "name", "description", "guidance",
    ]);
    expect(receivedSignal).toBe(signal);
    expect(JSON.stringify(payload)).not.toMatch(/apiKey|path|command|tools|timeout|baseUrl|executable/i);
  });
});

function input(): NpcStatsDraftRequestV1 {
  return {
    npcId: "npc:watchman",
    name: "Watchman",
    description: "A museum guard",
    guidance: "Former soldier",
    provider: "codex",
    model: "",
  };
}

function result() {
  return {
    type: "result",
    result: {
      status: "draft",
      provider: "codex",
      model: "",
      npcId: "npc:watchman",
      character: {
        characteristics: { str: 60, con: 50, siz: 55, dex: 65, int: 70, pow: 50 },
        skills: { Stealth: 55 },
        hitPoints: 10,
        sanity: 50,
      },
    },
  };
}
