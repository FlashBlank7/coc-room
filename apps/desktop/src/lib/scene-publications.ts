import { scenePublicEntitySchema, type ModulePackageV1, type ScenePublicEntityV1 } from "@coc-room/protocol";

export const scenePublicationKey = (sceneId: string, kind: "npc" | "location", entityId: string) => `scene:${JSON.stringify([sceneId, kind, entityId])}`;
export const sceneOpeningDraftKey = (sceneId: string) => `scene:${JSON.stringify([sceneId, "opening"])}`;
export const scenePublicationNameKey = (sceneId: string, kind: "npc" | "location", entityId: string) => `scene-name:${JSON.stringify([sceneId, kind, entityId])}`;
export const scenePublicationGuideKey = (sceneId: string) => `phase:${sceneId}`;
export const publicEntityVariantKey = (entry: ScenePublicEntityV1) => JSON.stringify([entry.kind, entry.entityId, entry.name, entry.text, entry.when.text]);

export function storedScenePublications(value?: string): ScenePublicEntityV1[] | undefined {
  if (!value) return undefined;
  try { return scenePublicEntitySchema.array().max(300).parse(JSON.parse(value)); } catch { return undefined; }
}

export function hasCompleteScenePublications(modulePackage: ModulePackageV1, sceneId: string, entries?: ScenePublicEntityV1[]): boolean {
  const scene = modulePackage.scenes.find((item) => item.id === sceneId);
  if (!scene) return false;
  return scene.npcIds.every((id) => entries?.some((entry) => entry.kind === "npc" && entry.entityId === id))
    && scene.locationIds.every((id) => entries?.some((entry) => entry.kind === "location" && entry.entityId === id))
    && (entries ?? []).every((entry) => entry.name !== undefined && (!entry.text.trim() || Boolean(entry.name.trim())));
}

/** Retain every reviewed variant of complete entities; fill missing entity groups only. */
export function supplementScenePublications(previous: ScenePublicEntityV1[] = [], generated: ScenePublicEntityV1[] = []): ScenePublicEntityV1[] {
  const key = (entry: ScenePublicEntityV1) => `${entry.kind}:${entry.entityId}`;
  const completeKeys = new Set(previous.map(key));
  for (const entry of previous) {
    if (entry.name === undefined || (entry.text.trim() && !entry.name.trim())) completeKeys.delete(key(entry));
  }
  const replacements = new Set(generated.map(key));
  return [...previous.filter((entry) => completeKeys.has(key(entry)) || !replacements.has(key(entry))), ...generated.filter((entry) => !completeKeys.has(key(entry)))];
}

export function requireCompleteScenePublications(modulePackage: ModulePackageV1, sceneId: string, entries?: ScenePublicEntityV1[]): ScenePublicEntityV1[] {
  const scene = modulePackage.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new Error("场景已经不存在，请重新打开备团资料。");
  const missing = [
    ...scene.npcIds.filter((id) => !entries?.some((entry) => entry.kind === "npc" && entry.entityId === id)),
    ...scene.locationIds.filter((id) => !entries?.some((entry) => entry.kind === "location" && entry.entityId === id)),
  ];
  if (!entries || missing.length || entries.some((entry) => entry.name === undefined || (entry.text.trim() && !entry.name.trim()))) throw new Error(`本幕登场说明未整理完整${missing.length ? `，还缺 ${missing.length} 项` : ""}。已有文案保留，可重试或手写。`);
  return entries;
}
