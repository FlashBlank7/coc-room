export type LocalAiRuntime = "native" | "web-bridge" | "web-no-bridge";

const LOCAL_AI_BRIDGE_TOKEN_META = "coc-room-local-ai-token";
const LOCAL_AI_BRIDGE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/**
 * Describes the execution boundary available to this renderer. A plain web
 * page can run the UI and join rooms, but it must not pretend it can inspect
 * host credentials or execute local AI unless Vite injected its per-process
 * bridge token.
 */
export function getLocalAiRuntime(): LocalAiRuntime {
  if ("__TAURI_INTERNALS__" in globalThis
    || (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window)) return "native";
  if (typeof document === "undefined") return "web-no-bridge";
  const token = document.querySelector<HTMLMetaElement>(
    `meta[name="${LOCAL_AI_BRIDGE_TOKEN_META}"]`,
  )?.content;
  return token && LOCAL_AI_BRIDGE_TOKEN_PATTERN.test(token)
    ? "web-bridge"
    : "web-no-bridge";
}

export function canExecuteLocalAi(runtime = getLocalAiRuntime()): boolean {
  return runtime !== "web-no-bridge";
}
