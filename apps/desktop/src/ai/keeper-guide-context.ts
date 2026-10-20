import { keeperGuideSchema, type KeeperGuideV1, type KeeperGuideNoteV1, type ModulePackageV1 } from "@coc-room/protocol";

export const GUIDE_INPUT_LIMIT = 300_000;

/** Preserve the actual scenario, including conditions and evidence. Never cut JSON or silently discard the ending. */
export function buildModuleDigest(modulePackage: ModulePackageV1, sourceText = ""): string {
  const { keeperGuide: _oldGuide, extensions: _extensions, ...content } = modulePackage;
  const sources = sourceText.trim() && modulePackage.sourceDocuments.length === 1
    ? [{ sourceId: modulePackage.sourceDocuments[0]!.id, text: sourceText }]
    : [];
  const digest = JSON.stringify({
    ...content,
    title: modulePackage.metadata.title,
    sourceCoverage: sources.length ? "full-text" : "excerpts-only",
    sources,
  });
  if ([...digest].length > GUIDE_INPUT_LIMIT) {
    throw new Error("这份模组与原文超过单次备团引导的容量。已整理资料仍保留；请按章节分开准备，内容没有被截断后交给 AI。");
  }
  return digest;
}

export function guideNotes(guide: KeeperGuideV1): KeeperGuideNoteV1[] {
  const preparation = guide.preparation;
  if (!preparation) return [];
  return [preparation.truth, preparation.hook, preparation.playerBriefing, ...preparation.essentials, ...preparation.timeline, ...preparation.endings,
    ...(preparation.publicClues ?? []).map((clue) => clue.when),
    ...preparation.cast.flatMap((npc) => npc.notes),
    ...preparation.scenes.flatMap((scene) => [scene.purpose, ...(scene.publicEntities ?? []).map((entity) => entity.when), ...scene.actions.map((action) => action.response), ...scene.exits, ...scene.pitfalls])];
}

/** Only exact quotes from supplied evidence survive. A quote match verifies provenance, not the model's interpretation. */
export function validateGuideEvidence(guide: KeeperGuideV1, modulePackage: ModulePackageV1, sourceText = ""): KeeperGuideV1 {
  const verified = keeperGuideSchema.parse(guide);
  validateNotesEvidence(guideNotes(verified), modulePackage, sourceText);
  return validateGuideReferences(verified, modulePackage);
}

export function validateNotesEvidence(notes: KeeperGuideNoteV1[], modulePackage: ModulePackageV1, sourceText = ""): void {
  const evidence = new Map<string, string[]>();
  if (sourceText.trim() && modulePackage.sourceDocuments.length === 1) {
    evidence.set(modulePackage.sourceDocuments[0]!.id, [sourceText]);
  }
  for (const entity of [...modulePackage.scenes, ...modulePackage.locations, ...modulePackage.npcs,
    ...modulePackage.clues, ...modulePackage.handouts, ...modulePackage.suggestedChecks,
    ...modulePackage.keeperNotes, ...modulePackage.relations]) {
    for (const source of entity.sourceRefs) {
      const hasFullSource = sourceText.trim() && modulePackage.sourceDocuments.length === 1 && source.sourceId === modulePackage.sourceDocuments[0]!.id;
      if (!hasFullSource && source.excerpt && modulePackage.sourceDocuments.some((document) => document.id === source.sourceId)) {
        evidence.set(source.sourceId, [...(evidence.get(source.sourceId) ?? []), source.excerpt]);
      }
    }
  }
  for (const note of notes) {
    const originalCount = note.sources.length;
    note.sources = note.sources.filter((quote) => evidence.get(quote.sourceId)?.some((text) => text.includes(quote.excerpt)));
    if (note.kind === "source" && (!note.sources.length || note.sources.length !== originalCount)) note.kind = "uncertain";
  }
}

function validateGuideReferences(verified: KeeperGuideV1, modulePackage: ModulePackageV1): KeeperGuideV1 {
  const preparation = verified.preparation;
  if (preparation) {
    const known = (id: string, values: readonly { id: string }[]) => values.some((value) => value.id === id);
    if ((preparation.publicClues ?? []).some((clue) => !known(clue.clueId, modulePackage.clues))
      || preparation.cast.some((npc) => !known(npc.npcId, modulePackage.npcs))
      || preparation.scenes.some((scene) => !known(scene.sceneId, modulePackage.scenes)
        || scene.actions.some((action) => action.checkId && !known(action.checkId, modulePackage.suggestedChecks)))) {
      throw new Error("备团引导引用了模组中不存在的人物、场景或检定，请重新生成；原资料未改变。");
    }
    if (new Set(preparation.scenes.map((scene) => scene.sceneId)).size !== preparation.scenes.length) throw new Error("主持引导包含重复场景，请重新整理；原资料未改变。");
    for (const scene of preparation.scenes) {
      const original = modulePackage.scenes.find((item) => item.id === scene.sceneId)!;
      if ((scene.publicEntities ?? []).some((entity) => !(entity.kind === "npc" ? original.npcIds : original.locationIds).includes(entity.entityId) || !known(entity.entityId, entity.kind === "npc" ? modulePackage.npcs : modulePackage.locations))) throw new Error("本幕介绍引用了不属于这个场景的人物或地点，请重新整理；原资料未改变。");
    }
    const missing = modulePackage.scenes.filter((scene) => !preparation.scenes.some((prepared) => prepared.sceneId === scene.id));
    if (missing.length) throw new Error(`主持引导尚缺 ${missing.length} 幕的现场参考（${missing.slice(0, 3).map((scene) => scene.name).join("、")}）。原资料已保留，请重新整理。`);
  }
  return verified;
}
