import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { localAiBridgePlugin } from "./dev/local-ai-bridge";

const developmentPort = parseDevelopmentPort(process.env.COC_ROOM_WEB_PORT);
const developmentOrigin = `http://127.0.0.1:${developmentPort}`;
const localAiBridgeEnabled = parseLocalAiBridgeEnabled(process.env.COC_ROOM_LOCAL_AI_BRIDGE);

export default defineConfig({
  plugins: [
    react(),
    ...(localAiBridgeEnabled
      ? [localAiBridgePlugin({
          workspaceRoot: fileURLToPath(new URL("../..", import.meta.url)),
          expectedOrigin: developmentOrigin,
        })]
      : []),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Web-first development reads the workspace source directly. Protocol
      // edits therefore participate in Vite HMR instead of waiting for a
      // possibly stale package dist build.
      "@coc-room/protocol": fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    cors: false,
    host: "127.0.0.1",
    port: developmentPort,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
  test: {
    setupFiles: "./src/test/setup.ts",
  },
});

function parseDevelopmentPort(candidate: string | undefined): number {
  if (candidate === undefined) return 1420;
  const port = Number(candidate);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("COC_ROOM_WEB_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseLocalAiBridgeEnabled(candidate: string | undefined): boolean {
  if (candidate === undefined || candidate === "enabled") return true;
  if (candidate === "disabled") return false;
  throw new Error("COC_ROOM_LOCAL_AI_BRIDGE must be either enabled or disabled");
}
