// Opt-in integration: real local provider, no browser automation or user-library writes.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { expect, it, vi } from "vitest";
import { modulePackageSchema } from "@coc-room/protocol";
import { prepareKeeperGuide } from "../../ai/keeper-workflow";

vi.mock("../../ai/web-development-ai-bridge", () => ({
  runWebDevelopmentAiTask: async (route: string, request: Record<string, unknown>, signal: AbortSignal) => {
    const stage = JSON.parse(String(request.digest)).workflowStage;
    const started = Date.now();
    const dir = process.env.COC_WORKFLOW_LIVE_DIR!;
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${started}-${stage}-input.json`), String(request.digest), "utf8");
    console.info(`workflow ${stage}: started`);
    let output: string;
    if (process.env.COC_WORKFLOW_SIDECAR_PYTHON) {
      // Exercise the very same fixed sidecar operation, independently of the dev server's single-user lock.
      if (route !== "keeper-guide") throw new Error("Unsupported quality harness route");
      output = await new Promise<string>((resolveOutput, reject) => {
        const child = spawn(process.env.COC_WORKFLOW_SIDECAR_PYTHON!, ["-m", "coc_module_parser"], {
          cwd: resolve(process.cwd(), "../../services/module-parser"), windowsHide: true, signal,
          env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        });
        let stdout = "";
        child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
        child.stderr.resume();
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolveOutput(stdout) : reject(new Error(`Sidecar exited ${code}`)));
        child.stdin.end(JSON.stringify({ ...request, action: "generate_keeper_guide" }) + "\n");
      });
    } else {
      const base = process.env.COC_WORKFLOW_LIVE_URL!;
      const html = await (await fetch(base)).text();
      const token = /name="coc-room-local-ai-token" content="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
      if (!token) throw new Error("Missing local bridge token");
      const response = await fetch(`${base}/__coc_room_local_ai/v1/${route}`, { method: "POST", signal,
        headers: { "content-type": "application/json", "x-coc-room-local-ai": token, origin: base }, body: JSON.stringify(request) });
      if (!response.ok) throw new Error(`Bridge HTTP ${response.status}`);
      output = await response.text();
    }
    const messages = output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    console.info(`workflow ${stage}: ${Math.round((Date.now() - started) / 1000)}s`);
    writeFileSync(resolve(dir, `workflow-live-${stage}-${started}.json`), JSON.stringify(messages, null, 2), "utf8");
    appendFileSync(resolve(dir, "timings.jsonl"), JSON.stringify({ stage, started, seconds: (Date.now() - started) / 1000, messages: messages.map((message) => message.type) }) + "\n", "utf8");
    return messages;
  },
}));

it.skipIf(!process.env.COC_WORKFLOW_LIVE_URL && !process.env.COC_WORKFLOW_SIDECAR_PYTHON)("runs the complete preparation workflow with the original scenario and saves every checkpoint", async () => {
  const dir = process.env.COC_WORKFLOW_LIVE_DIR!;
  mkdirSync(dir, { recursive: true });
  const input = process.env.COC_WORKFLOW_LIVE_INPUT;
  if (!input) throw new Error("COC_WORKFLOW_LIVE_INPUT must identify the full scenario digest");
  const { title: _title, sourceCoverage: _coverage, sources, preparationScope: _scope, preparationCastIds: _cast, ...raw } = JSON.parse(readFileSync(input, "utf8"));
  const modulePackage = modulePackageSchema.parse({ ...raw, keeperGuide: undefined, extensions: raw.extensions ?? {} });
  const saved = process.env.COC_WORKFLOW_RESUME ? JSON.parse(readFileSync(resolve(dir, "workflow-live-checkpoint.cocmod.json"), "utf8")) : modulePackage;
  const result = await prepareKeeperGuide({ modulePackage: saved, sourceText: sources[0].text, provider: "codex", model: "", semanticReview: true, signal: new AbortController().signal,
    onPartial: (guide) => { writeFileSync(resolve(dir, "workflow-live-checkpoint.cocmod.json"), JSON.stringify({ ...modulePackage, keeperGuide: guide }, null, 2), "utf8"); },
  });
  expect(result.workflow?.evidence?.facts.length).toBeGreaterThan(0);
  expect(result.workflow?.plan?.scenes).toHaveLength(modulePackage.scenes.length);
  expect(result.workflow?.audit).toBeDefined();
  expect(["complete", "needs-review"]).toContain(result.workflow?.stage);
  expect(result.workflow?.pending).toBeUndefined();
  expect(result.preparation?.scenes).toHaveLength(modulePackage.scenes.length);
  writeFileSync(resolve(dir, "result.cocmod.json"), JSON.stringify({ ...modulePackage, keeperGuide: result }, null, 2), "utf8");
  // Completing requests is deliberately separate from the content acceptance report.
}, 14_400_000);
