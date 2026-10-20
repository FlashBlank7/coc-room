import {
  keeperEvidenceSchema, keeperGuideSchema, keeperPlanSchema, keeperReviewSchema,
  type KeeperGuideV1, type KeeperReview, type KeeperWorkflow, type ModulePackageV1,
} from "@coc-room/protocol";
import { generateKeeperGuide, normalizeGuide, runKeeperGuideStep, type GenerateKeeperGuideOptions } from "./keeper-guide";
import { buildModuleDigest, validateNotesEvidence } from "./keeper-guide-context";
import { prepareKeeperGuideBatches } from "./keeper-preparation";
import { hasCompleteScenePublications } from "../lib/scene-publications";

type Options = GenerateKeeperGuideOptions & {
  onPartial?(guide: KeeperGuideV1): Promise<void> | void;
  /** Diagnostic runs only. Normal preparation gives the keeper reference material. */
  semanticReview?: boolean;
};

export async function keeperContentHash(value: unknown): Promise<string> {
  // Sorted keys survive JSON export/import; array order remains significant.
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, stable(value)])) : item;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(stable(value))));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const emptyGuide = (): KeeperGuideV1 => ({ schemaVersion: 1, truth: "", hook: "", clueTrail: [], timeline: [], endings: [], pacing: "" });
const content = ({ workflow: _workflow, ...guide }: KeeperGuideV1) => guide;
const affectsOverview = (finding: KeeperReview["findings"][number]) => /(?:^|\.)(truth|hook|essentials|playerBriefing|timeline|endings)(?:\.|\[|$)/u.test(finding.field);

export async function keeperInputHash(modulePackage: ModulePackageV1, sourceText: string | undefined, provider: string, model: string): Promise<string> {
  const { revision: _revision, metadata, ...digest } = JSON.parse(buildModuleDigest(modulePackage, sourceText));
  const { createdAt: _created, updatedAt: _updated, ...metadataContent } = metadata;
  return keeperContentHash({ version: 1, digest: { ...digest, metadata: metadataContent }, provider, model });
}

export function unresolvedKeeperFindings(workflow: KeeperWorkflow): KeeperReview["findings"] {
  const findings = [...workflow.reviews.flatMap((entry) => entry.review.findings), ...(workflow.pending?.review?.findings ?? []), ...(workflow.audit?.findings ?? [])];
  return [...new Map(findings.map((finding) => [JSON.stringify([finding.sceneIds, finding.field, finding.note.text]), finding])).values()];
}

/** Each arrow is a separate model request. Only code, not the writer, decides completion. */
export async function prepareKeeperGuide(options: Options): Promise<KeeperGuideV1> {
  const checkAbort = () => { if (options.signal.aborted) throw options.signal.reason ?? new Error("主持引导已停止"); };
  checkAbort();
  const { modulePackage } = options;
  const inputHash = await keeperInputHash(modulePackage, options.sourceText, options.provider, options.model);
  let guide = modulePackage.keeperGuide ?? emptyGuide();
  const previous = guide.workflow;
  const contentHash = await keeperContentHash(content(guide));
  const resumable = previous?.version === 1 && previous.inputHash === inputHash && previous.contentHash === contentHash && previous.stage !== "complete";
  const priorAuditFindings = resumable && previous.stage === "needs-review" ? previous.audit?.findings ?? [] : [];
  const completeContent = guide.preparation && modulePackage.scenes.every((scene) => hasCompleteScenePublications(modulePackage, scene.id, guide.preparation?.scenes.find((entry) => entry.sceneId === scene.id)?.publicEntities) && guide.preparation?.scenes.some((entry) => entry.sceneId === scene.id))
    && modulePackage.npcs.every((npc) => guide.preparation?.cast.some((entry) => entry.npcId === npc.id));
  let workflow: KeeperWorkflow = resumable ? structuredClone(previous) : {
    version: 1, inputHash, contentHash, provider: options.provider, model: options.model, stage: "extract", reviews: [],
    restartFromBeginning: Boolean(completeContent && !(previous && previous.contentHash !== contentHash)),
  };
  // Earlier checkpoints treated scene association as an instruction to repeat
  // every related future event. Retain semantic findings, discard only these
  // mechanically added batch errors; whole-book coverage remains mandatory.
  const removeScopeFalsePositives = (review: KeeperReview) => {
    review.findings = review.findings.filter((finding) => !(finding.note.title === "相关条件尚未核对"
      && review.checks.some((check) => check.verdict === "not-applicable" && finding.field === `facts.${check.factId}`)));
  };
  workflow.reviews.forEach((entry) => removeScopeFalsePositives(entry.review));
  if (workflow.pending?.review && !workflow.finalRepair) removeScopeFalsePositives(workflow.pending.review);
  if (workflow.stage === "needs-review") {
    delete workflow.audit;
    // A new explicit preparation request may retry unresolved findings. The
    // budget stays bounded within each invocation; resuming an interrupted
    // repair must retain its existing queue and repair count.
    if (workflow.finalRepair?.remaining.length === 0) delete workflow.finalRepair;
  }
  const checkpoint = async (stage: KeeperWorkflow["stage"]) => {
    checkAbort();
    workflow.stage = stage;
    workflow.contentHash = await keeperContentHash(content(guide));
    guide = keeperGuideSchema.parse({ ...guide, workflow });
    await options.onPartial?.(guide);
    checkAbort();
  };
  const knownSceneIds = new Set(modulePackage.scenes.map((scene) => scene.id));
  const validateScenes = (ids: string[]) => { if (ids.some((id) => !knownSceneIds.has(id))) throw new Error("中间资料引用了不存在的场景，进度已保留。"); };
  const stageContext = () => ({ workflowEvidence: workflow.evidence, workflowPlan: workflow.plan });

  if (!workflow.evidence) {
    await checkpoint("extract");
    const evidence = keeperEvidenceSchema.parse(await runKeeperGuideStep(options, { workflowStage: "extract" }));
    checkAbort();
    if (new Set(evidence.facts.map((fact) => fact.id)).size !== evidence.facts.length) throw new Error("事实台账含重复编号，请重试此步骤。");
    evidence.facts.forEach((fact) => validateScenes(fact.sceneIds));
    validateNotesEvidence(evidence.facts.map((fact) => fact.note), modulePackage, options.sourceText);
    workflow.evidence = evidence;
    await checkpoint("plan");
  }
  if (!workflow.plan) {
    await checkpoint("plan");
    const plan = keeperPlanSchema.parse(await runKeeperGuideStep(options, { workflowStage: "plan", ...stageContext() }));
    checkAbort();
    validateScenes(plan.scenes.map((scene) => scene.sceneId));
    if (new Set(plan.scenes.map((scene) => scene.sceneId)).size !== modulePackage.scenes.length || plan.scenes.length !== modulePackage.scenes.length) throw new Error("场景计划有缺项或重复，已保留事实台账，可继续整理。");
    const factIds = new Set(workflow.evidence.facts.map((fact) => fact.id));
    if (plan.scenes.some((scene) => scene.factIds.some((id) => !factIds.has(id)))) throw new Error("场景计划引用了不存在的事实，已保留台账。");
    // Never let the planning model silently drop an extracted cross-scene prerequisite.
    for (const scene of plan.scenes) scene.factIds = [...new Set([...scene.factIds, ...workflow.evidence.facts.filter((fact) => !fact.sceneIds.length || fact.sceneIds.includes(scene.sceneId)).map((fact) => fact.id)])];
    validateNotesEvidence(plan.scenes.map((scene) => scene.alternativeRoutes), modulePackage, options.sourceText);
    workflow.plan = plan;
    await checkpoint("draft");
  }

  if (!options.semanticReview) {
    // Reference mode keeps source grounding and scene planning, without asking
    // additional models to approve and repeatedly rewrite the keeper's notes.
    if (workflow.finalRepair) delete workflow.pending;
    delete workflow.finalRepair;
    delete workflow.audit;
    workflow.reviews = [];
    guide = await prepareKeeperGuideBatches({ ...options,
      modulePackage: { ...modulePackage, keeperGuide: workflow.restartFromBeginning ? undefined : guide },
      preserveExisting: resumable || Boolean(previous && previous.contentHash !== contentHash),
      generateBatch: async (batch) => {
        const key = JSON.stringify({ scenes: batch.modulePackage.scenes.map((scene) => scene.id), cast: batch.preparationCastIds, scope: batch.preparationScope });
        if (workflow.pending && workflow.pending.key !== key) throw new Error("待整理草稿与当前批次不一致，已有资料已保留。");
        if (workflow.pending) return normalizeGuide({ preparation: workflow.pending.preparation });
        await checkpoint("draft");
        const candidate = await generateKeeperGuide({ ...batch, workflowContext: { workflowStage: "draft", ...stageContext() } });
        checkAbort();
        if (!candidate.preparation) throw new Error("写作步骤没有返回主持参考");
        workflow.pending = { key, preparation: candidate.preparation, repairs: 0 };
        await checkpoint("draft");
        return candidate;
      },
      onPartial: async (merged) => {
        guide = merged;
        workflow.restartFromBeginning = false;
        delete workflow.pending;
        await checkpoint("draft");
      },
    });
    await checkpoint(workflow.evidence.facts.some((fact) => fact.note.kind === "uncertain") || !options.sourceText?.trim() || modulePackage.sourceDocuments.length !== 1 ? "needs-review" : "complete");
    return guide;
  }

  const review = async (candidate: KeeperGuideV1, scope: string, recheckCorrectedLedger = true): Promise<KeeperReview> => {
    // Review sees all source scenes, including conditions described outside this batch.
    const result = keeperReviewSchema.parse(await runKeeperGuideStep(options, {
      workflowStage: "review", ...stageContext(), reviewScope: scope,
      candidate: { preparation: candidate.preparation },
      ...(scope === "scene-batch" ? { alreadyPrepared: guide.preparation } : {}),
      ...(scope === "audit" ? { priorFindings: [...priorAuditFindings, ...unresolvedKeeperFindings(workflow)] } : {}),
    }));
    checkAbort();
    const factIds = new Set(workflow.evidence!.facts.map((fact) => fact.id));
    if (result.checks.length !== factIds.size || new Set(result.checks.map((check) => check.factId)).size !== factIds.size || result.checks.some((check) => !factIds.has(check.factId))) throw new Error("审查没有逐条核对事实台账，草稿已保留，可继续审查。");
    result.findings.forEach((finding) => validateScenes(finding.sceneIds));
    validateNotesEvidence(result.findings.map((finding) => finding.note), modulePackage, options.sourceText);
    // The extractor can misinterpret a quote. A reviewer may correct an existing
    // fact with verified source text; never invent or silently drop a fact ID.
    const correctedFields = new Set<string>();
    for (const finding of result.findings) {
      const fact = workflow.evidence!.facts.find((item) => finding.field === `workflowEvidence.facts.${item.id}`);
      if (fact && finding.note.kind === "source" && finding.note.sources.length && JSON.stringify(fact.note) !== JSON.stringify(finding.note)) {
        fact.note = structuredClone(finding.note);
        correctedFields.add(finding.field);
      }
    }
    if (correctedFields.size && recheckCorrectedLedger) {
      // Clear only the ledger corrections actually applied, never prose issues.
      for (const entry of workflow.reviews) entry.review.findings = entry.review.findings.filter((finding) => !correctedFields.has(finding.field));
      await checkpoint(scope === "audit" ? "audit" : "review");
      return review(candidate, scope, false);
    }
    if (result.checks.some((check) => check.verdict === "issue") && !result.findings.length) throw new Error("审查发现问题但未给出修正依据，草稿已保留，可继续审查。");
    // A claim of coverage is insufficient if relevant constraints were skipped.
    for (const check of result.checks) {
      const fact = workflow.evidence!.facts.find((fact) => fact.id === check.factId)!;
      if (check.verdict === "not-applicable" && scope === "audit") {
        result.findings.push({ severity: "error", sceneIds: fact.sceneIds, field: `facts.${fact.id}`, note: { title: "相关条件尚未核对", text: `${fact.note.text}\n审查跳过了这项条件：${check.reason}`, kind: "uncertain", sources: fact.note.sources } });
      }
    }
    return keeperReviewSchema.parse(result);
  };

  const generateBatch: typeof generateKeeperGuide = async (batch) => {
    const key = JSON.stringify({ scenes: batch.modulePackage.scenes.map((scene) => scene.id), cast: batch.preparationCastIds, scope: batch.preparationScope });
    const bookRepair = Boolean(workflow.finalRepair && batch.modulePackage.scenes.length === modulePackage.scenes.length);
    const reviewScope = bookRepair ? "audit" : batch.preparationScope ?? "opening";
    if (workflow.pending && workflow.pending.key !== key) throw new Error("待审查草稿与当前批次不一致，已有资料已保留。");
    if (!workflow.pending) {
      await checkpoint("draft");
      const candidate = await generateKeeperGuide({ ...batch, workflowContext: { workflowStage: "draft", ...stageContext() } });
      checkAbort();
      if (!candidate.preparation) throw new Error("写作步骤没有返回主持参考");
      workflow.pending = { key, preparation: candidate.preparation, repairs: 0 };
      await checkpoint("review");
    }
    let candidate = normalizeGuide({ preparation: workflow.pending.preparation });
    if (!workflow.pending.review) {
      await checkpoint("review");
      workflow.pending.review = await review(candidate, reviewScope);
      await checkpoint("review");
    }
    if (workflow.pending.review.findings.some((finding) => finding.severity === "error") && workflow.pending.repairs < 1) {
      await checkpoint("repair");
      candidate = keeperGuideSchema.parse(await runKeeperGuideStep(batch, {
        workflowStage: "patch", ...stageContext(), candidate: { preparation: candidate.preparation }, review: workflow.pending.review,
      }));
      checkAbort();
      workflow.pending = { key, preparation: candidate.preparation!, repairs: 1 };
      await checkpoint("review");
      workflow.pending.review = await review(candidate, reviewScope);
      await checkpoint("review");
    }
    // The complete-book recheck sees every prior finding and supersedes earlier
    // batch checks; legacy partial repair queues still retain unrelated reviews.
    workflow.reviews = [...(bookRepair ? [] : workflow.reviews.filter((entry) => entry.key !== key)), { key, review: workflow.pending.review }];
    // Kept until onPartial saves the merged guide atomically with the cleared pending draft.
    return candidate;
  };

  if (!workflow.finalRepair) guide = await prepareKeeperGuideBatches({ ...options, modulePackage: { ...modulePackage, keeperGuide: workflow.restartFromBeginning ? undefined : guide },
    preserveExisting: resumable || Boolean(previous && previous.contentHash !== contentHash), generateBatch,
    onPartial: async (merged) => {
      guide = merged;
      workflow.restartFromBeginning = false;
      delete workflow.pending;
      delete workflow.audit;
      await checkpoint("draft");
    },
  });
  // Final independent pass checks the real merged result, including retained keeper edits.
  if (!workflow.audit) {
    await checkpoint("audit");
    workflow.audit = await review(guide, "audit");
  }
  // A merged-book audit can discover errors no individual batch saw. Give it
  // one bounded repair pass, retaining the queue and candidate across cancellation.
  // Keeper-edited prose is reviewed but never replaced by this automatic pass.
  const keeperEdited = Boolean(previous && previous.contentHash !== contentHash);
  if (!workflow.finalRepair && !keeperEdited) {
    const errors = unresolvedKeeperFindings(workflow).filter((finding) => finding.severity === "error");
    if (errors.length) {
      // Patch output is small, so final repair can see the complete book. This
      // avoids independently rewriting the same shared rule in several batches.
      const sceneIds = modulePackage.scenes.map((scene) => scene.id);
      const castIds = modulePackage.npcs.map((npc) => npc.id);
      const scope = "opening" as const;
      workflow.finalRepair = { remaining: [{ key: JSON.stringify({ scenes: sceneIds, cast: castIds, scope }), sceneIds, castIds, scope }] };
      await checkpoint("repair");
    }
  }
  while (workflow.finalRepair?.remaining.length) {
    const target = workflow.finalRepair.remaining[0]!;
    const scenes = modulePackage.scenes.filter((scene) => target.sceneIds.includes(scene.id));
    const clueIds = new Set(scenes.flatMap((scene) => scene.clueIds));
    if (!workflow.pending) {
      const preparation = guide.preparation!;
      workflow.pending = { key: target.key, repairs: 0, preparation: {
        ...preparation, scenes: preparation.scenes.filter((scene) => target.sceneIds.includes(scene.sceneId)),
        cast: preparation.cast.filter((npc) => target.castIds.includes(npc.npcId)),
        publicClues: preparation.publicClues?.filter((clue) => clueIds.has(clue.clueId)),
      }, review: { checks: [], findings: unresolvedKeeperFindings(workflow).filter((finding) =>
        !finding.sceneIds.length || finding.sceneIds.some((id) => target.sceneIds.includes(id)) || target.scope === "opening" && affectsOverview(finding)) } };
      await checkpoint("repair");
    }
    const repaired = await generateBatch({ ...options, modulePackage: { ...modulePackage, scenes },
      preparationScope: target.scope, preparationCastIds: target.castIds });
    const current = guide.preparation!;
    const next = repaired.preparation!;
    const replacements = new Map(next.scenes.map((scene) => [scene.sceneId, scene]));
    const cast = new Map(current.cast.map((npc) => [npc.npcId, npc]));
    next.cast.forEach((npc) => cast.set(npc.npcId, npc));
    guide = normalizeGuide({ ...guide, preparation: {
      // A patch preserves untouched global notes. Keep deliberate shared-note
      // corrections even when the finding was located in a later scene.
      ...next,
      scenes: current.scenes.map((scene) => {
        const replacement = replacements.get(scene.sceneId);
        return replacement ? target.scope === "scene-publications" ? { ...scene, publicEntities: replacement.publicEntities } : replacement : scene;
      }),
      cast: [...cast.values()],
      publicClues: target.scope === "scene-publications" ? current.publicClues
        : [...(current.publicClues ?? []).filter((clue) => !clueIds.has(clue.clueId)), ...(next.publicClues ?? [])],
    } });
    workflow.finalRepair.remaining.shift();
    delete workflow.pending;
    // Persist the merge and queue together; retain the original audit until the
    // last patch so subsequent repairs still see its outstanding findings.
    if (!workflow.finalRepair.remaining.length) delete workflow.audit;
    await checkpoint("repair");
  }
  if (!workflow.audit) {
    await checkpoint("audit");
    workflow.audit = await review(guide, "audit");
  }
  const needsReview = unresolvedKeeperFindings(workflow).length > 0 || workflow.evidence.facts.some((fact) => fact.note.kind === "uncertain") || !options.sourceText?.trim() || modulePackage.sourceDocuments.length !== 1;
  await checkpoint(needsReview ? "needs-review" : "complete");
  return guide;
}
