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
  return next;
}
