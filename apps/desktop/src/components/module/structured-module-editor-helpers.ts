import type { ModulePackageV1 } from "@coc-room/protocol";

export type StructuredModuleCollection =
  | "chapters"
  | "scenes"
  | "locations"
  | "npcs"
  | "clues"
  | "handouts"
  | "suggestedChecks"
  | "keeperNotes";

export function removeEntityAndReferences(
  modulePackage: ModulePackageV1,
  collection: StructuredModuleCollection,
  id: string,
): ModulePackageV1 {
  const next = { ...modulePackage, [collection]: modulePackage[collection].filter((item) => item.id !== id) } as ModulePackageV1;
  next.chapters = next.chapters.map((item) => ({ ...item, sceneIds: collection === "scenes" ? item.sceneIds.filter((ref) => ref !== id) : item.sceneIds }));
  next.scenes = next.scenes.map((item) => ({
    ...item,
    locationIds: collection === "locations" ? item.locationIds.filter((ref) => ref !== id) : item.locationIds,
    npcIds: collection === "npcs" ? item.npcIds.filter((ref) => ref !== id) : item.npcIds,
    clueIds: collection === "clues" ? item.clueIds.filter((ref) => ref !== id) : item.clueIds,
    handoutIds: collection === "handouts" ? item.handoutIds.filter((ref) => ref !== id) : item.handoutIds,
    suggestedCheckIds: collection === "suggestedChecks" ? item.suggestedCheckIds.filter((ref) => ref !== id) : item.suggestedCheckIds,
  }));
  next.keeperNotes = next.keeperNotes.map((item) => ({ ...item, relatedEntityIds: item.relatedEntityIds.filter((ref) => ref !== id) }));
  next.relations = next.relations.filter((relation) => relation.fromEntityId !== id && relation.toEntityId !== id);
  if (next.keeperGuide) {
    const guide = next.keeperGuide;
    next.keeperGuide = {
      ...guide,
      clueTrail: guide.clueTrail.filter((step) => collection !== "scenes" || step.sceneId !== id).map((step) => ({ ...step,
        keyClues: step.keyClues.filter((clue) => collection !== "clues" || clue.clueId !== id),
      })),
      ...(guide.preparation ? { preparation: { ...guide.preparation,
        publicClues: guide.preparation.publicClues?.filter((clue) => collection !== "clues" || clue.clueId !== id),
        cast: guide.preparation.cast.filter((npc) => collection !== "npcs" || npc.npcId !== id),
        scenes: guide.preparation.scenes.filter((scene) => collection !== "scenes" || scene.sceneId !== id).map((scene) => ({ ...scene,
          publicEntities: scene.publicEntities?.filter((entry) => !((collection === "npcs" && entry.kind === "npc") || (collection === "locations" && entry.kind === "location")) || entry.entityId !== id),
          actions: scene.actions.map((action) => {
            if (collection !== "suggestedChecks" || action.checkId !== id) return action;
            const { checkId: _removed, ...rest } = action;
            return rest;
          }),
        })),
      } } : {}),
    };
  }
  return next;
}
