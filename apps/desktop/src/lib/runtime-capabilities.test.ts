// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { canExecuteLocalAi, getLocalAiRuntime } from "./runtime-capabilities";

afterEach(() => {
  document.head.innerHTML = "";
  Reflect.deleteProperty(globalThis, "__TAURI_INTERNALS__");
});

describe("local AI runtime capability", () => {
  it("does not mistake a plain web page for a local AI executor", () => {
    expect(getLocalAiRuntime()).toBe("web-no-bridge");
    expect(canExecuteLocalAi()).toBe(false);
  });

  it("recognizes only a valid per-process web bridge token", () => {
    document.head.innerHTML = '<meta name="coc-room-local-ai-token" content="too-short">';
    expect(getLocalAiRuntime()).toBe("web-no-bridge");
    document.head.innerHTML = '<meta name="coc-room-local-ai-token" content="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">';
    expect(getLocalAiRuntime()).toBe("web-bridge");
    expect(canExecuteLocalAi()).toBe(true);
  });

  it("prefers the native boundary even when no web token exists", () => {
    Object.defineProperty(globalThis, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    expect(getLocalAiRuntime()).toBe("native");
    expect(canExecuteLocalAi()).toBe(true);
  });
});
