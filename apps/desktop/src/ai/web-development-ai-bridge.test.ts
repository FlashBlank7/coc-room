// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runWebDevelopmentAiTask,
  WebDevelopmentAiBridgeError,
} from "./web-development-ai-bridge";

const token = "a".repeat(43);
const request = {
  id: "00000000-0000-4000-8000-000000000111",
  provider: "codex",
  model: "",
  prompt: "一位记者",
  playerName: "玩家甲",
  ownerSeatId: "seat-player",
};

describe("web development AI bridge client", () => {
  beforeEach(() => {
    document.head.innerHTML = `<meta name="coc-room-local-ai-token" content="${token}">`;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
  });

  it("uses only the fixed same-origin route and injected development capability", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(`${JSON.stringify(resultEvent())}\n`, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(runWebDevelopmentAiTask("character-draft", request, controller.signal))
      .resolves.toEqual([resultEvent()]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/__coc_room_local_ai/v1/character-draft");
    expect(init).toMatchObject({
      method: "POST",
      mode: "same-origin",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    expect(init.headers).toEqual({
      "content-type": "application/json",
      "x-coc-room-local-ai": token,
    });
    expect(JSON.parse(String(init.body))).toEqual(request);
  });

  it("forwards cancellation to fetch without converting it into a provider failure", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      receivedSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        receivedSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }));

    const operation = runWebDevelopmentAiTask("character-draft", request, controller.signal);
    const reason = new Error("stop locally");
    controller.abort(reason);

    await expect(operation).rejects.toBe(reason);
    expect(receivedSignal).toBe(controller.signal);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("rejects mismatched, truncated, and multiple-terminal JSONL", async () => {
    const cases = [
      `${JSON.stringify({ ...resultEvent(), request_id: "other" })}\n`,
      JSON.stringify(resultEvent()),
      `${JSON.stringify(resultEvent())}\n${JSON.stringify(resultEvent())}\n`,
    ];
    for (const body of cases) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
      await expect(runWebDevelopmentAiTask("character-draft", request, new AbortController().signal))
        .rejects.toThrow();
    }
  });

  it("never exposes arbitrary HTTP or provider error details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: "UPSTREAM_FAILURE", message: "secret prompt and provider detail" },
    }), { status: 502 })));
    const httpFailure = runWebDevelopmentAiTask("character-draft", request, new AbortController().signal);
    await expect(httpFailure).rejects.toBeInstanceOf(WebDevelopmentAiBridgeError);
    await expect(httpFailure).rejects.not.toThrow(/secret|provider detail/i);

    const upstreamError = {
      protocol_version: "1.0",
      request_id: request.id,
      type: "error",
      message: "secret prompt and provider detail",
      error: { code: "UPSTREAM_FAILURE", message: "secret prompt and provider detail", retryable: true },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(`${JSON.stringify(upstreamError)}\n`, { status: 200 })));
    const messages = await runWebDevelopmentAiTask("character-draft", request, new AbortController().signal);
    expect(JSON.stringify(messages)).not.toMatch(/secret|provider detail/i);
    expect(messages).toEqual([expect.objectContaining({
      type: "error",
      message: "角色草稿生成失败，未创建替代内容",
    })]);
  });

  it("requires the ephemeral token injected into this Vite document", async () => {
    document.head.innerHTML = "";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(runWebDevelopmentAiTask("character-draft", request, new AbortController().signal))
      .rejects.toThrow("开发会话");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [403, "INVALID_BRIDGE_SESSION", "刷新页面后重新生成"],
    [500, "BRIDGE_INTERNAL_ERROR", "本地 AI 服务发生内部错误"],
  ])("explains HTTP %s (%s) without exposing upstream details", async (status, code, instruction) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code, message: "PRIVATE_PROMPT_OR_CREDENTIAL" },
    }), { status })));
    const error = await runWebDevelopmentAiTask("character-draft", request, new AbortController().signal)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(WebDevelopmentAiBridgeError);
    expect(error).toMatchObject({ code, message: expect.stringContaining(instruction) });
    expect((error as Error).message).toContain(code);
    expect((error as Error).message).not.toContain("PRIVATE_PROMPT_OR_CREDENTIAL");
  });
});

function resultEvent() {
  return {
    protocol_version: "1.0",
    request_id: request.id,
    type: "result",
    result: { character: { name: "余弦" } },
  };
}
