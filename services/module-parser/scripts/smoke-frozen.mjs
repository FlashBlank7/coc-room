import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const defaultBinary =
  "apps/desktop/src-tauri/binaries/module-parser-x86_64-pc-windows-msvc.exe";
const binary = resolve(process.argv[2] ?? process.env.COC_MODULE_PARSER_BINARY ?? defaultBinary);

if (!existsSync(binary)) {
  throw new Error(`Frozen sidecar was not found: ${binary}`);
}

const requestId = "frozen-utf8-smoke";
const sourceText = "# 见世之蝶 🦋\n地点：月读古书堂\nNPC：花小路";
const request = {
  id: requestId,
  action: "parse_module",
  source_text: sourceText,
  source_name: "中文冒烟.md",
  model: "deterministic-v1",
  mock: true,
};

const child = spawnSync(binary, [], {
  input: `${JSON.stringify(request)}\n`,
  encoding: "utf8",
  windowsHide: true,
  timeout: 120_000,
  maxBuffer: 16 * 1024 * 1024,
});

if (child.error) {
  throw child.error;
}
if (child.signal) {
  throw new Error(`Frozen sidecar terminated by signal ${child.signal}`);
}
if (child.status !== 0) {
  const stderr = child.stderr.trim();
  throw new Error(
    `Frozen sidecar exited with ${child.status}${stderr ? `: ${stderr}` : ""}`,
  );
}

const lines = child.stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
const messages = lines.map((line, index) => {
  try {
    return JSON.parse(index === 0 ? line.replace(/^\uFEFF/u, "") : line);
  } catch (error) {
    throw new Error(`Frozen sidecar emitted invalid JSONL on line ${index + 1}`, {
      cause: error,
    });
  }
});

if (messages.length === 0) {
  throw new Error("Frozen sidecar emitted no JSONL messages");
}
if (messages.some((message) => message.request_id !== requestId)) {
  throw new Error("Frozen sidecar emitted a message for an unexpected request ID");
}

const errorMessage = messages.find((message) => message.type === "error");
if (errorMessage) {
  throw new Error(`Frozen sidecar returned an error: ${errorMessage.message ?? "unknown error"}`);
}

const results = messages.filter((message) => message.type === "result");
if (results.length !== 1) {
  throw new Error(`Frozen sidecar emitted ${results.length} result messages; expected exactly one`);
}

const result = results[0];
if (result.normalizedText !== sourceText) {
  throw new Error("Frozen sidecar did not preserve the UTF-8 source text");
}
if (result.module?.metadata?.title !== "见世之蝶 🦋") {
  throw new Error("Frozen sidecar did not preserve the UTF-8 module title");
}
if (!result.module?.locations?.some((location) => location.name === "月读古书堂")) {
  throw new Error("Frozen sidecar did not preserve the UTF-8 location name");
}
if (!result.module?.npcs?.some((npc) => npc.name === "花小路")) {
  throw new Error("Frozen sidecar did not preserve the UTF-8 NPC name");
}

process.stdout.write(`Frozen sidecar UTF-8 smoke passed (${messages.length} messages)\n`);
