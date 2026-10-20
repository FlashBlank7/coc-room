import { keeperGuideSchema, type KeeperGuideV1 } from "@coc-room/protocol";
import { generateKeeperGuide, type GenerateKeeperGuideOptions } from "./keeper-guide";
import { publicClueVariantKey } from "../lib/clue-discovery";
import { hasCompleteScenePublications, supplementScenePublications } from "../lib/scene-publications";

/** Publish useful preparation in small recoverable batches. Later failures must not erase earlier scenes. */
export { prepareKeeperGuide } from "./keeper-workflow";

export async function prepareKeeperGuideBatches(options: GenerateKeeperGuideOptions & {
  onPartial?(guide: KeeperGuideV1): Promise<void> | void;
  generateBatch?: typeof generateKeeperGuide;
  preserveExisting?: boolean;
}): Promise<KeeperGuideV1> {
  const generate = options.generateBatch ?? generateKeeperGuide;
  const modulePackage = options.modulePackage;
  const existing = modulePackage.keeperGuide;
  const completedIds = new Set(existing?.preparation?.scenes.map((scene) => scene.sceneId));
  const missing = modulePackage.scenes.filter((scene) => !completedIds.has(scene.id));
  const missingCast = modulePackage.npcs.some((npc) => !existing?.preparation?.cast.some((entry) => entry.npcId === npc.id));
  const missingPublications = modulePackage.scenes.some((scene) => !hasCompleteScenePublications(modulePackage, scene.id, existing?.preparation?.scenes.find((entry) => entry.sceneId === scene.id)?.publicEntities));
  // An explicit regenerate on a complete guide starts fresh; a partial guide resumes.
  let guide = existing?.preparation && (options.preserveExisting || missing.length > 0 || missingCast || missingPublications) ? existing : undefined;
  const pending = guide ? missing : modulePackage.scenes;
  // The first response should let a new keeper understand the story and start
  // its opening, without waiting for every NPC's portrayal notes.
  const first = !guide && pending.length ? [pending.slice(0, 1)] : [];
  const rest = first.length ? pending.slice(1) : pending;
  const batches = [...first, ...Array.from({ length: Math.ceil(rest.length / 3) }, (_, index) => rest.slice(index * 3, index * 3 + 3))];
  if (!batches.length && (!guide || missingCast)) batches.push([]);
  for (const [index, scenes] of batches.entries()) {
    if (options.signal.aborted) throw options.signal.reason ?? new Error("主持引导已停止");
    const presentCast = new Set(guide?.preparation?.cast.map((npc) => npc.npcId));
    const sceneCast = new Set(scenes.flatMap((scene) => scene.npcIds));
    const preparationCastIds = modulePackage.npcs.filter((npc) => !presentCast.has(npc.id) && (index === batches.length - 1 || sceneCast.has(npc.id))).map((npc) => npc.id);
    const next = await generate({ ...options,
      modulePackage: { ...modulePackage, scenes },
      preparationScope: guide ? "scene-batch" : "opening",
      preparationCastIds,
    });
    if (options.signal.aborted) throw options.signal.reason ?? new Error("主持引导已停止");
    if (guide?.preparation && next.preparation) {
      const clues = new Map((guide.preparation.publicClues ?? []).map((clue) => [publicClueVariantKey(clue), clue]));
      for (const clue of next.preparation.publicClues ?? []) if (!clues.has(publicClueVariantKey(clue))) clues.set(publicClueVariantKey(clue), clue);
      const cast = new Map(guide.preparation.cast.map((npc) => [npc.npcId, npc]));
      for (const npc of next.preparation.cast) if (!cast.has(npc.npcId)) cast.set(npc.npcId, npc);
      guide = keeperGuideSchema.parse({ ...guide,
        clueTrail: [...guide.clueTrail, ...next.clueTrail],
        preparation: { ...guide.preparation,
          scenes: [...guide.preparation.scenes, ...next.preparation.scenes],
          cast: [...cast.values()],
          publicClues: [...clues.values()],
        },
      });
    } else guide = next;
    await options.onPartial?.(guide);
  }
  if (!guide) throw new Error("没有生成主持引导；原资料仍保留。");
  // Older guides and partial model replies can have full scene notes while
  // still lacking safe introductions. Fill only those gaps, retaining the
  // keeper's edited story and already complete disclosure variants.
  const publicationScenes = modulePackage.scenes.filter((scene) => !hasCompleteScenePublications(modulePackage, scene.id, guide!.preparation?.scenes.find((entry) => entry.sceneId === scene.id)?.publicEntities));
  for (let offset = 0; offset < publicationScenes.length; offset += 3) {
    if (options.signal.aborted) throw options.signal.reason ?? new Error("主持引导已停止");
    const scenes = publicationScenes.slice(offset, offset + 3);
    const next = await generate({ ...options, modulePackage: { ...modulePackage, scenes }, preparationScope: "scene-publications", preparationCastIds: [] });
    if (options.signal.aborted) throw options.signal.reason ?? new Error("主持引导已停止");
    const additions = new Map(next.preparation?.scenes.map((scene) => [scene.sceneId, scene.publicEntities]));
    guide = keeperGuideSchema.parse({
      ...guide,
      preparation: { ...guide.preparation!, scenes: guide.preparation!.scenes.map((scene) => additions.has(scene.sceneId)
        ? { ...scene, publicEntities: supplementScenePublications(scene.publicEntities, additions.get(scene.sceneId)) }
        : scene) },
    });
    await options.onPartial?.(guide);
    const incomplete = scenes.filter((scene) => !hasCompleteScenePublications(modulePackage, scene.id, guide!.preparation?.scenes.find((entry) => entry.sceneId === scene.id)?.publicEntities));
    if (incomplete.length) throw new Error(`已保留新整理的登场资料，仍有 ${incomplete.length} 幕缺项。可以继续补全，不必重做已有主持参考。`);
  }
  // Retain useful scene results before reporting omissions, so one missing NPC
  // never discards a whole model response or forces the same scenes to rerun.
  const incompleteScenes = modulePackage.scenes.filter((scene) => !guide.preparation?.scenes.some((entry) => entry.sceneId === scene.id));
  if (incompleteScenes.length) throw new Error(`已保留现有参考，尚缺 ${incompleteScenes.length} 幕；可以继续补全，无需重做已完成的场景。`);
  const incompleteCast = modulePackage.npcs.filter((npc) => !guide.preparation?.cast.some((entry) => entry.npcId === npc.id));
  if (incompleteCast.length) throw new Error(`已保留故事和场景参考，尚缺 ${incompleteCast.length} 位人物；可以继续补全，无需重做已完成的场景。`);
  return guide;
}
