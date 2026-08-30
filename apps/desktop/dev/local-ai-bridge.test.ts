import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  bindHttpDisconnectAbort,
  createBridgeSidecarEnvironment,
  FIXED_AI_TIMEOUT_MS,
  hasExactlyOneTerminalMessage,
  sanitizeSidecarMessage,
  SIDECAR_IDLE_TIMEOUT_MS,
  SIDECAR_TOTAL_TIMEOUT_MS,
  SidecarLifecycle,
  validateBridgeHttpRequest,
  validateCharacterDraftRequest,
  validateNpcReplyRequest,
  validateImageJobRequest,
  validateNpcStatsDraftRequest,
  validateParseRequest,
  validateRenderRequest,
  validateSidecarActivityMessage,
} from "./local-ai-bridge";

const origin = "http://127.0.0.1:1420";
const sessionToken = "a".repeat(43);

describe("local AI bridge boundary", () => {
  it("accepts any loopback spelling of the Vite origin and requires the session header", () => {
    expect(() => validateBridgeHttpRequest({
      method: "POST",
      headers: {
        host: "127.0.0.1:1420",
        origin,
        "content-type": "application/json",
        "x-coc-room-local-ai": sessionToken,
        "sec-fetch-site": "same-origin",
      },
    }, origin, sessionToken)).not.toThrow();

    expect(() => validateBridgeHttpRequest({
      method: "POST",
      headers: { host: "127.0.0.1:1420", origin: "https://attacker.invalid", "content-type": "application/json", "x-coc-room-local-ai": sessionToken },
    }, origin, sessionToken)).toThrow("只接受当前 Vite 页面");
    // A page opened as localhost is the same loopback dev server; both the
    // Origin and Host headers must be accepted in either spelling.
    expect(() => validateBridgeHttpRequest({
      method: "POST",
      headers: { host: "localhost:1420", origin: "http://localhost:1420", "content-type": "application/json", "x-coc-room-local-ai": sessionToken, "sec-fetch-site": "same-origin" },
    }, origin, sessionToken)).not.toThrow();
    expect(() => validateBridgeHttpRequest({
      method: "POST",
      headers: { host: "localhost:1421", origin: "http://localhost:1421", "content-type": "application/json", "x-coc-room-local-ai": sessionToken, "sec-fetch-site": "same-origin" },
    }, origin, sessionToken)).toThrow("只接受当前 Vite 页面");
    expect(() => validateBridgeHttpRequest({
      method: "POST",
      headers: { host: "127.0.0.1:1420", origin, "content-type": "application/json" },
    }, origin, sessionToken)).toThrow("开发会话无效");
    expect(() => validateBridgeHttpRequest({
      method: "POST",
      headers: { host: "127.0.0.1:1420", origin, "content-type": "application/json", "x-coc-room-local-ai": sessionToken, "sec-fetch-site": "cross-site" },
    }, origin, sessionToken)).toThrow("拒绝跨站请求");
    // Browsers that never send Sec-Fetch-Site are still same-origin here; the
    // session token is the real gate.
    expect(() => validateBridgeHttpRequest({
      method: "POST",
      headers: { host: "127.0.0.1:1420", origin, "content-type": "application/json", "x-coc-room-local-ai": sessionToken },
    }, origin, sessionToken)).not.toThrow();

    expect(() => validateBridgeHttpRequest({
      method: "POST",
      headers: { host: "127.0.0.1:1420", origin, "content-type": "application/json", "x-coc-room-local-ai": "1" },
    }, origin, sessionToken)).toThrow("开发会话无效");
    expect(() => validateBridgeHttpRequest({
      method: "POST",
      headers: { host: "127.0.0.1:1420", origin, "content-type": "text/plain", "x-coc-room-local-ai": sessionToken, "sec-fetch-site": "same-origin" },
    }, origin, sessionToken)).toThrow("只接受 JSON 请求");
  });

  it("passes the full environment minus provider API keys to the Python wrapper", () => {
    const environment = createBridgeSidecarEnvironment(
      "C:\\workspace\\services\\module-parser",
      "C:\\temp\\bridge",
      "C:\\cache\\parser",
      {
        PATH: "C:\\Windows\\System32",
        USERPROFILE: "C:\\Users\\keeper",
        HTTPS_PROXY: "http://127.0.0.1:8080",
        // SYSTEMROOT must flow through: without it codex hangs in schannel TLS.
        SYSTEMROOT: "C:\\Windows",
        OPENAI_API_KEY: "must-not-be-inherited",
        CODEX_API_KEY: "must-not-be-inherited",
        DEEPSEEK_API_KEY: "must-not-be-inherited",
      },
    );

    expect(environment).toMatchObject({
      PATH: "C:\\Windows\\System32",
      USERPROFILE: "C:\\Users\\keeper",
      HTTPS_PROXY: "http://127.0.0.1:8080",
      SYSTEMROOT: "C:\\Windows",
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      COC_ROOM_DEV_BRIDGE_TEMP_ROOT: "C:\\temp\\bridge",
      COC_ROOM_DEV_BRIDGE_CACHE_DIR: "C:\\cache\\parser",
    });
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("CODEX_API_KEY");
    expect(environment).not.toHaveProperty("DEEPSEEK_API_KEY");
  });

  it("accepts a bounded text parse but rejects path, credential, and tool fields", () => {
    expect(validateParseRequest({
      id: "parse_01",
      sourceText: "# 雾中车站",
      sourceName: "station.md",
      provider: "codex",
      model: "",
      mock: false,
    })).toMatchObject({ provider: "codex", sourceName: "station.md" });

    for (const forbidden of [
      { sourcePath: "C:\\secret.txt" },
      { apiKey: "must-never-cross-the-browser-boundary" },
      { command: "whoami" },
      { tools: ["shell"] },
      { timeoutMs: 90_000 },
      { idleTimeoutMs: 90_000 },
    ]) {
      expect(() => validateParseRequest({
        id: "parse_01",
        sourceText: "# 雾中车站",
        sourceName: "station.md",
        provider: "codex",
        model: "",
        mock: false,
        ...forbidden,
      })).toThrow("不接受字段");
    }
  });

  it("checks uploaded PDF length and SHA-256 before allowing a bounded page render", () => {
    const bytes = Buffer.from("%PDF-1.7\n% test only", "utf8");
    const sourceFile = {
      name: "scenario.pdf",
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      dataBase64: bytes.toString("base64"),
    };
    expect(validateRenderRequest({ id: "render_01", sourceFile, pageNumbers: [1, 3] })).toMatchObject({
      id: "render_01",
      pageNumbers: [1, 3],
    });
    expect(() => validateRenderRequest({
      id: "render_01",
      sourceFile: { ...sourceFile, sha256: "0".repeat(64) },
      pageNumbers: [1],
    })).toThrow("哈希不匹配");
    expect(() => validateRenderRequest({ id: "render_01", sourceFile, pageNumbers: [1, 1] })).toThrow("不重复整数");
    expect(() => validateParseRequest({
      id: "parse_pdf_01",
      sourceFile,
      sourceName: sourceFile.name,
      provider: "deepseek",
      model: "deepseek-test",
      mock: false,
    })).toThrow("PDF 模组解析只支持 Codex");
  });

  it("counts only protocol-valid JSONL envelopes bound to the active request", () => {
    expect(validateSidecarActivityMessage({
      protocol_version: "1.0",
      request_id: "parse_01",
      type: "progress",
      stage: "codex_waiting",
      message: "Codex 仍在运行",
    }, "parse_01")).toMatchObject({ type: "progress", stage: "codex_waiting" });

    expect(() => validateSidecarActivityMessage({
      protocol_version: "1.0",
      request_id: "other_request",
      type: "progress",
      stage: "codex_waiting",
      message: "wrong task",
    }, "parse_01")).toThrow("响应 ID 不匹配");
    expect(() => validateSidecarActivityMessage({
      protocol_version: "1.0",
      request_id: "parse_01",
      type: "heartbeat",
    }, "parse_01")).toThrow("JSONL 类型无效");
    expect(() => validateSidecarActivityMessage({
      protocol_version: "1.0",
      request_id: "parse_01",
      type: "progress",
    }, "parse_01")).toThrow("进度心跳结构无效");
  });

  it("accepts only exact, bounded character and NPC draft fields", () => {
    const character = {
      id: "00000000-0000-4000-8000-000000000101",
      provider: "codex",
      model: "",
      prompt: "蝶".repeat(100_000),
      playerName: "玩家甲",
      ownerSeatId: "seat-player",
    };
    expect(validateCharacterDraftRequest(character).prompt).toHaveLength(100_000);
    expect(() => validateCharacterDraftRequest({ ...character, prompt: "蝶".repeat(100_001) }))
      .toThrow("长度无效");

    const stats = {
      id: "00000000-0000-4000-8000-000000000102",
      provider: "deepseek",
      model: "deepseek-test",
      npcId: "npc:keeper",
      name: "守门人",
      description: "雾".repeat(100_000),
      guidance: "",
    };
    expect(validateNpcStatsDraftRequest(stats).description).toHaveLength(100_000);
    expect(() => validateNpcStatsDraftRequest({ ...stats, description: `${stats.description}雾` }))
      .toThrow("长度无效");

    for (const forbidden of [
      "apiKey", "sourcePath", "command", "tools", "timeoutMs", "baseUrl",
      "codexExecutable", "room", "module",
    ]) {
      expect(() => validateCharacterDraftRequest({ ...character, [forbidden]: "blocked" }))
        .toThrow("不接受字段");
      expect(() => validateNpcStatsDraftRequest({ ...stats, [forbidden]: "blocked" }))
        .toThrow("不接受字段");
    }
  });

  it("accepts only exact, bounded image job fields", () => {
    const job = {
      id: "00000000-0000-4000-8000-000000000103",
      kind: "character",
      description: "雨夜里的侦探",
      aspectRatio: "portrait",
    };
    expect(validateImageJobRequest(job)).toMatchObject({ kind: "character", aspectRatio: "portrait" });
    expect(validateImageJobRequest({ ...job, style: "旧纸蚀刻", model: "gpt-image" }).style).toBe("旧纸蚀刻");
    expect(() => validateImageJobRequest({ ...job, kind: "banner" })).toThrow("图片任务类型无效");
    expect(() => validateImageJobRequest({ ...job, aspectRatio: "wide" })).toThrow("图片比例无效");
    expect(() => validateImageJobRequest({ ...job, description: "蝶".repeat(20_001) })).toThrow("长度无效");
    expect(() => validateImageJobRequest({ ...job, id: "not-a-uuid" })).toThrow("任务 ID 无效");
    for (const forbidden of ["apiKey", "sourcePath", "command", "tools", "timeoutMs", "authorization"]) {
      expect(() => validateImageJobRequest({ ...job, [forbidden]: "blocked" })).toThrow("不接受字段");
    }
  });

  it("recursively bounds the NPC panel context and rejects proxy fields", () => {
    const reply = safeNpcReplyRequest();
    expect(validateNpcReplyRequest(reply).messages).toHaveLength(1);
    expect(validateNpcReplyRequest({
      ...reply,
      messages: [{ ...reply.messages[0], content: "蝶".repeat(100_000) }],
    }).messages).toHaveLength(1);
    expect(() => validateNpcReplyRequest({
      ...reply,
      messages: [{ ...reply.messages[0], content: "蝶".repeat(100_001) }],
    })).toThrow("长度无效");
    expect(() => validateNpcReplyRequest({
      ...reply,
      npcCard: { ...reply.npcCard, source_refs: [{ start: 1 }] },
    })).toThrow("不能携带原文引用");
    expect(() => validateNpcReplyRequest({
      ...reply,
      messages: [{ ...reply.messages[0], roomContext: "hidden" }],
    })).toThrow("不接受字段");
    for (const forbidden of [
      "apiKey", "sourcePath", "command", "tool", "timeoutSeconds", "baseUrl",
      "codexExecutable", "room", "module",
    ]) {
      expect(() => validateNpcReplyRequest({ ...reply, [forbidden]: "blocked" }))
        .toThrow("不接受字段");
    }
  });

  it("requires one final terminal and strips sidecar error details", () => {
    const progress = { type: "progress" };
    const result = { type: "result" };
    const error = { type: "error" };
    expect(hasExactlyOneTerminalMessage([progress, result])).toBe(true);
    expect(hasExactlyOneTerminalMessage([result, error])).toBe(false);
    expect(hasExactlyOneTerminalMessage([result, progress])).toBe(false);

    const sanitized = sanitizeSidecarMessage({
      protocol_version: "1.0",
      request_id: "00000000-0000-4000-8000-000000000101",
      type: "error",
      message: "secret prompt",
      error: {
        code: "UPSTREAM_FAILURE",
        message: "secret provider detail",
        retryable: true,
        details: { path: "C:/private" },
      },
    }, "generate_character_draft");
    expect(JSON.stringify(sanitized)).not.toMatch(/secret|private|path/i);
    expect(sanitized).toMatchObject({
      type: "error",
      message: "角色草稿生成失败，未创建替代内容",
      error: { code: "UPSTREAM_FAILURE", retryable: true },
    });
  });
});

describe("local AI bridge task lifecycle", () => {
  it("expires after 60 seconds without a valid JSONL message and resets only when noted", () => {
    vi.useFakeTimers();
    try {
      const expired = vi.fn();
      const lifecycle = new SidecarLifecycle(expired);

      vi.advanceTimersByTime(SIDECAR_IDLE_TIMEOUT_MS - 1);
      expect(expired).not.toHaveBeenCalled();
      lifecycle.noteValidMessage();
      vi.advanceTimersByTime(SIDECAR_IDLE_TIMEOUT_MS - 1);
      expect(expired).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(expired).toHaveBeenCalledOnce();
      expect(expired).toHaveBeenCalledWith("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps 15-second JSONL heartbeats alive but never extends the fixed 45-minute cap", () => {
    vi.useFakeTimers();
    try {
      const expired = vi.fn();
      const lifecycle = new SidecarLifecycle(expired);
      const heartbeatInterval = 15_000;
      const heartbeatsBeforeDeadline = SIDECAR_TOTAL_TIMEOUT_MS / heartbeatInterval - 1;

      for (let index = 0; index < heartbeatsBeforeDeadline; index += 1) {
        vi.advanceTimersByTime(heartbeatInterval);
        lifecycle.noteValidMessage();
      }
      expect(expired).not.toHaveBeenCalled();
      vi.advanceTimersByTime(heartbeatInterval);
      expect(expired).toHaveBeenCalledOnce();
      expect(expired).toHaveBeenCalledWith("total");
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns request aborts and premature response closes into cancellation signals", () => {
    class FakeResponse extends EventEmitter {
      writableEnded = false;
    }

    const abortedRequest = new EventEmitter();
    const response = new FakeResponse();
    const first = bindHttpDisconnectAbort(abortedRequest, response);
    abortedRequest.emit("aborted");
    expect(first.signal.aborted).toBe(true);
    first.dispose();

    const request = new EventEmitter();
    const disconnectedResponse = new FakeResponse();
    const second = bindHttpDisconnectAbort(request, disconnectedResponse);
    disconnectedResponse.emit("close");
    expect(second.signal.aborted).toBe(true);
    second.dispose();

    const completedRequest = new EventEmitter();
    const completedResponse = new FakeResponse();
    completedResponse.writableEnded = true;
    const third = bindHttpDisconnectAbort(completedRequest, completedResponse);
    completedResponse.emit("close");
    expect(third.signal.aborted).toBe(false);
    third.dispose();
  });

  it("gives fixed AI tasks one 120-second total deadline without an idle deadline", () => {
    vi.useFakeTimers();
    try {
      const expired = vi.fn();
      const lifecycle = new SidecarLifecycle(expired, FIXED_AI_TIMEOUT_MS, null);
      vi.advanceTimersByTime(SIDECAR_IDLE_TIMEOUT_MS);
      expect(expired).not.toHaveBeenCalled();
      vi.advanceTimersByTime(FIXED_AI_TIMEOUT_MS - SIDECAR_IDLE_TIMEOUT_MS);
      expect(expired).toHaveBeenCalledOnce();
      expect(expired).toHaveBeenCalledWith("total");
    } finally {
      vi.useRealTimers();
    }
  });
});

function safeNpcReplyRequest() {
  return {
    id: "00000000-0000-4000-8000-000000000103",
    provider: "codex" as const,
    model: "",
    npcCard: {
      id: "npc:keeper",
      name: "守门人",
      description: "谨慎",
      role: "看守",
      motivations: ["守住大门"],
      traits: ["寡言"],
      source_refs: [],
    },
    pins: [{ id: "pin:door", title: "大门", content: "门已上锁" }],
    messages: [{ id: "message:1", role: "human" as const, content: "你好" }],
  };
}
