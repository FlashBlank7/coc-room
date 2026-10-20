import {
  keeperGuideSchema,
  keeperEvidenceSchema, keeperPlanSchema, keeperReviewSchema,
  type KeeperGuideV1,
  type ModulePackageV1,
} from "@coc-room/protocol";
import { ZodError } from "zod";
import { getRepository } from "../data/repository";
import { DEEPSEEK_KEY_MISSING_MESSAGE, callBrowserDeepSeek } from "./browser-deepseek";
import { runWebDevelopmentAiTask } from "./web-development-ai-bridge";

import { invoke } from "@tauri-apps/api/core";
import contract from "./keeper-guide-contract.json";
import workflowContracts from "./keeper-workflow-contracts.json";
import { buildModuleDigest, validateGuideEvidence } from "./keeper-guide-context";
import { applyKeeperRepairPatch, KeeperPatchError } from "./keeper-repair-patch";
export { buildModuleDigest } from "./keeper-guide-context";
const KEEPER_GUIDE_INSTRUCTIONS = contract.instructions;
const GUIDE_JSON_SCHEMA = contract.schema;

export interface GenerateKeeperGuideOptions {
  modulePackage: ModulePackageV1;
  provider: "deepseek" | "codex";
  model: string;
  signal: AbortSignal;
  sourceText?: string;
  preparationScope?: "opening" | "scene-batch" | "scene-publications";
  preparationCastIds?: string[];
  workflowContext?: Record<string, unknown>;
}

export async function generateKeeperGuide(options: GenerateKeeperGuideOptions): Promise<KeeperGuideV1> {
  return validateGuideEvidence(normalizeGuide(await runKeeperGuideStep(options, options.workflowContext)), options.modulePackage, options.sourceText);
}

/** Shared fixed-contract transport for every pipeline step and provider. */
export async function runKeeperGuideStep(options: GenerateKeeperGuideOptions, context: Record<string, unknown> = {}): Promise<unknown> {
  let outputRetryReason: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await runKeeperGuideStepOnce(options, { ...context, ...(attempt ? { outputRetry: true, ...(outputRetryReason ? { outputRetryReason } : {}) } : {}) });
      if (context.workflowStage === "extract") return keeperEvidenceSchema.parse(raw);
      if (context.workflowStage === "plan") return keeperPlanSchema.parse(raw);
      if (context.workflowStage === "review") return keeperReviewSchema.parse(raw);
      if (context.workflowStage === "patch") return applyKeeperRepairPatch(normalizeGuide(context.candidate), raw, options.modulePackage, options.sourceText);
      if (context.workflowStage === "draft" || context.workflowStage === "repair") {
        if (!isRecord(raw) || !isRecord(raw.preparation)) throw new KeeperStepError("INVALID_STRUCTURE");
        return normalizeGuide(raw);
      }
      return raw;
    } catch (cause) {
      // One bounded output-format retry stays inside the current node; source/plan are not regenerated.
      const invalidOutput = cause instanceof ZodError || cause instanceof KeeperPatchError || cause instanceof KeeperStepError && ["INVALID_STRUCTURE", "TRUNCATED_RESPONSE", "EMPTY_RESPONSE"].includes(cause.code);
      if (options.signal.aborted || attempt > 0 || !context.workflowStage || !invalidOutput) throw cause;
      if (cause instanceof KeeperPatchError) outputRetryReason = cause.message.slice(0, 500);
    }
  }
  throw new Error("本步骤输出校验失败，已保留进度。");
}

async function runKeeperGuideStepOnce(options: GenerateKeeperGuideOptions, context: Record<string, unknown>): Promise<unknown> {
  if (options.signal.aborted) throw options.signal.reason ?? new Error("备团引导已停止");
  const fullDigest = buildModuleDigest(options.modulePackage, options.sourceText);
  const digest = JSON.stringify({ ...JSON.parse(fullDigest), preparationScope: options.preparationScope, preparationCastIds: options.preparationCastIds, ...context });
  if ([...digest].length > 300_000) throw new Error("本步骤原文与中间资料超过容量，已保存进度；请按章节准备。");
  const stage = context.workflowStage as keyof typeof workflowContracts | undefined;
  if (stage && !Object.hasOwn(workflowContracts, stage)) throw new Error("未知备团步骤");
  const selected = stage ? workflowContracts[stage] : { instructions: KEEPER_GUIDE_INSTRUCTIONS, schema: GUIDE_JSON_SCHEMA };
  if ("__TAURI_INTERNALS__" in globalThis) {
    const id = crypto.randomUUID();
    let nativeCleanup = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      const abort = () => reject(options.signal.reason ?? new Error("备团引导已停止"));
      options.signal.addEventListener("abort", abort, { once: true });
      nativeCleanup = () => options.signal.removeEventListener("abort", abort);
    });
    let cleanupCancel = () => {};
    try {
      const cancel = () => { void invoke("cancel_keeper_guide", { requestId: id }).catch(() => undefined); };
      options.signal.addEventListener("abort", cancel, { once: true });
      cleanupCancel = () => options.signal.removeEventListener("abort", cancel);
      const raw = await Promise.race([invoke("run_keeper_guide", { request: { id, provider: options.provider, model: options.model, digest } }), cancelled]);
      return extractBridgeGuide(raw);
    } finally { cleanupCancel(); nativeCleanup(); }
  }
  if (options.provider === "deepseek") {
    const apiKey = (await (await getRepository()).getSetting("deepseekApiKey"))?.trim();
    if (apiKey) {
      const payload = await callBrowserDeepSeek({
        apiKey,
        ...(options.model.trim() ? { model: options.model } : {}),
        instructions: selected.instructions,
        inputJson: digest,
        schemaName: "coc7_keeper_guide_v1",
        schema: selected.schema,
        maxOutputTokens: 16_384,
        signal: options.signal,
      });
      return payload;
    }
  }
  try {
    const raw = await runWebDevelopmentAiTask("keeper-guide", {
      id: globalThis.crypto.randomUUID(),
      provider: options.provider,
      model: options.model,
      digest,
    }, options.signal);
    return extractBridgeGuide(raw);
  } catch (error) {
    if (options.provider === "deepseek" && error instanceof Error && error.message.includes("本地 AI 开发会话")) {
      throw new Error(DEEPSEEK_KEY_MISSING_MESSAGE);
    }
    throw error;
  }
}

function extractBridgeGuide(value: unknown): unknown {
  if (!Array.isArray(value)) throw new Error("运行指引 sidecar 返回了非法消息列表");
  for (const message of value) {
    if (isRecord(message) && message.type === "error") {
      const code = isRecord(message.error) && typeof message.error.code === "string" && /^[A-Z0-9_]{1,80}$/u.test(message.error.code) ? message.error.code : "LOCAL_AI_FAILED";
      throw new KeeperStepError(code);
    }
  }
  for (const message of value) {
    if (!isRecord(message) || message.type !== "result" || !isRecord(message.result)) continue;
    if (message.result.guide !== undefined) return message.result.guide;
  }
  throw new Error("运行指引提供者没有返回内容");
}

class KeeperStepError extends Error {
  constructor(readonly code: string) { super(`运行指引生成失败，当前步骤的进度已保留，可以重试。（${code}）`); }
}

/** Null optional ids become absent; the protocol schema is the final word. */
export function normalizeGuide(payload: unknown): KeeperGuideV1 {
  if (!isRecord(payload)) throw new Error("运行指引结构无效");
  if (!isRecord(payload.preparation)) throw new Error("提供者只返回了旧式摘要，没有初次主持引导。已整理资料仍保留，请重试。");
  const clueTrail = Array.isArray(payload.clueTrail) ? payload.clueTrail.map((step) => {
    if (!isRecord(step)) return step;
    return {
      ...(typeof step.sceneId === "string" && step.sceneId.length > 0 ? { sceneId: step.sceneId } : {}),
      title: step.title,
      goal: step.goal ?? "",
      leadIn: step.leadIn ?? "",
      keyClues: Array.isArray(step.keyClues) ? step.keyClues.map((clue) => {
        if (!isRecord(clue)) return clue;
        return {
          ...(typeof clue.clueId === "string" && clue.clueId.length > 0 ? { clueId: clue.clueId } : {}),
          summary: clue.summary,
          pointsTo: clue.pointsTo ?? "",
        };
      }) : [],
      ifStuck: step.ifStuck ?? "",
    };
  }) : [];
  return keeperGuideSchema.parse({
    schemaVersion: 1,
    truth: isRecord(payload.preparation.truth) ? payload.preparation.truth.text : payload.truth ?? "",
    hook: isRecord(payload.preparation.hook) ? payload.preparation.hook.text : payload.hook ?? "",
    clueTrail,
    timeline: payload.timeline ?? [],
    endings: payload.endings ?? [],
    pacing: payload.pacing ?? "",
    ...(payload.preparation ? { preparation: normalizePreparation(payload.preparation) } : {}),
  });
}

function normalizePreparation(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.scenes)) return value;
  return { ...value, scenes: value.scenes.map((scene) => {
    if (!isRecord(scene) || !Array.isArray(scene.actions)) return scene;
    return { ...scene, actions: scene.actions.map((action) => {
      if (!isRecord(action)) return action;
      const { checkId, ...rest } = action;
      return { ...rest, ...(typeof checkId === "string" && checkId ? { checkId } : {}) };
    }) };
  }) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Guide runs are owned here, not by any view: navigating away must neither
 * cancel a run nor hide that it is still going. Finished runs save the module
 * as a NEW revision (the repository rightly refuses in-place rewrites).
 */
interface KeeperGuideRun {
  readonly abort: AbortController;
  readonly startedAt: number;
}

const keeperGuideRuns = new Map<string, KeeperGuideRun>();
const keeperGuideErrors = new Map<string, string>();
const keeperGuideListeners = new Set<() => void>();

function notifyKeeperGuideListeners(): void {
  for (const listener of [...keeperGuideListeners]) listener();
}

export function subscribeKeeperGuideRuns(listener: () => void): () => void {
  keeperGuideListeners.add(listener);
  return () => keeperGuideListeners.delete(listener);
}

export function isKeeperGuideRunning(moduleId: string): boolean {
  return keeperGuideRuns.has(moduleId);
}

export function keeperGuideRunError(moduleId: string): string | undefined {
  return keeperGuideErrors.get(moduleId);
}

export function stopKeeperGuideRun(moduleId: string): void {
  keeperGuideRuns.get(moduleId)?.abort.abort(new Error("已停止生成运行指引"));
  keeperGuideRuns.delete(moduleId);
  notifyKeeperGuideListeners();
}

export async function startKeeperGuideRun(options: {
  modulePackage: ModulePackageV1;
  provider: "deepseek" | "codex";
  model: string;
}): Promise<void> {
  const moduleId = options.modulePackage.moduleId;
  if (keeperGuideRuns.has(moduleId)) return;
  const abort = new AbortController();
  keeperGuideRuns.set(moduleId, { abort, startedAt: Date.now() });
  keeperGuideErrors.delete(moduleId);
  notifyKeeperGuideListeners();
  try {
    const repository = await getRepository();
    const stored = await repository.getModule(options.modulePackage.moduleId, options.modulePackage.revision);
    const draftId = `keeper-guide:${moduleId}:${options.modulePackage.revision}`;
    const recovered = await repository.getModuleDraft(draftId);
    const { prepareKeeperGuide } = await import("./keeper-workflow");
    const guide = await prepareKeeperGuide({
      modulePackage: recovered?.package ?? options.modulePackage,
      provider: options.provider,
      model: options.model,
      signal: abort.signal,
      sourceText: stored?.sourceText ?? "",
      onPartial: async (partial) => {
        if (abort.signal.aborted) throw abort.signal.reason;
        await repository.saveModuleDraft({ draftId, package: { ...options.modulePackage, keeperGuide: partial }, sourceText: stored?.sourceText ?? "", sourceName: "", warnings: [], updatedAt: new Date().toISOString() });
      },
    });
    if (abort.signal.aborted) return;
    const latest = await repository.getModule(options.modulePackage.moduleId);
    if (latest && latest.package.revision !== options.modulePackage.revision) {
      throw new Error("生成期间模组已有新修改，请打开最新版本后重新生成引导。新修改没有被覆盖。");
    }
    await repository.saveModule({
      package: {
        ...options.modulePackage,
        revision: options.modulePackage.revision + 1,
        metadata: { ...options.modulePackage.metadata, updatedAt: new Date().toISOString() },
        keeperGuide: guide,
      },
      sourceText: stored?.sourceText ?? "",
    });
    await repository.deleteModuleDraft(draftId);
  } catch (cause) {
    if (!abort.signal.aborted) {
      keeperGuideErrors.set(moduleId, cause instanceof Error ? cause.message : String(cause));
    }
  } finally {
    if (keeperGuideRuns.get(moduleId)?.abort === abort) {
      keeperGuideRuns.delete(moduleId);
      notifyKeeperGuideListeners();
    }
  }
}
