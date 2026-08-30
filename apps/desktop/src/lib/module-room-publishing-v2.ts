import {
  isAudienceSubsetV2,
  type AudienceV2,
  type ModulePackageV1,
  type RoomArtifactV2,
  type RoomEntityV2,
} from "@coc-room/protocol";

export type ModuleRoomEntityKindV2 = Extract<RoomEntityV2["kind"], "location" | "npc">;
export type ModuleRoomArtifactKindV2 = Extract<RoomArtifactV2["kind"], "clue" | "handout">;
export type ModuleRoomSourceKindV2 = ModuleRoomEntityKindV2 | ModuleRoomArtifactKindV2;

export interface ModuleRoomSourceRefV2 {
  readonly moduleId: string;
  readonly revision: number;
  readonly kind: ModuleRoomSourceKindV2;
  readonly id: string;
}

export interface ModuleEntityPublicationInputV2 {
  readonly sourceId: string;
  readonly kind: ModuleRoomEntityKindV2;
  readonly name: string;
  readonly description: string;
  readonly audience: AudienceV2;
}

export interface ModuleArtifactPublicationInputV2 {
  readonly sourceId: string;
  readonly kind: ModuleRoomArtifactKindV2;
  readonly title: string;
  readonly body: string;
  readonly audience: AudienceV2;
}

export function moduleRoomSourceRefV2(
  modulePackage: Pick<ModulePackageV1, "moduleId" | "revision">,
  kind: ModuleRoomSourceKindV2,
  id: string,
): ModuleRoomSourceRefV2 {
  return { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind, id };
}

/** Existing payload recipients may stay unchanged or be explicitly expanded;
 * silently narrowing a snapshot would violate V2's no-retraction rule. */
export function isCompatibleModulePublicationAudienceV2(
  existing: AudienceV2,
  requested: AudienceV2,
): boolean {
  return isAudienceSubsetV2(existing, requested);
}

export function findPublishedModuleEntityV2(
  entities: ReadonlyMap<string, RoomEntityV2>,
  modulePackage: Pick<ModulePackageV1, "moduleId" | "revision">,
  sourceId: string,
  kind: ModuleRoomEntityKindV2,
  audience: AudienceV2,
): RoomEntityV2 | undefined {
  const expected = moduleRoomSourceRefV2(modulePackage, kind, sourceId);
  return [...entities.values()].find((entity) =>
    entity.kind === kind
      && matchesModuleRoomSourceRefV2(entity.data.sourceRef, expected)
      && isCompatibleModulePublicationAudienceV2(entity.audience, audience),
  );
}

export function buildPublishedModuleEntityV2(
  entities: ReadonlyMap<string, RoomEntityV2>,
  modulePackage: Pick<ModulePackageV1, "moduleId" | "revision">,
  input: ModuleEntityPublicationInputV2,
  createId: () => string,
): RoomEntityV2 {
  const sourceRef = moduleRoomSourceRefV2(modulePackage, input.kind, input.sourceId);
  const existing = findPublishedModuleEntityV2(
    entities,
    modulePackage,
    input.sourceId,
    input.kind,
    input.audience,
  );
  if (existing) {
    return {
      ...existing,
      revision: existing.revision + 1,
      name: input.name,
      description: input.description,
      audience: input.audience,
      // Presentation links, NPC statistics, token metadata and later feature
      // namespaces live here. Updating the module-authored public copy must
      // only replace its source pointer, never reset the rest of the room state.
      data: { ...existing.data, sourceRef },
      extensions: { ...existing.extensions },
    };
  }
  return {
    schemaVersion: 2,
    entityId: createId(),
    revision: 1,
    kind: input.kind,
    name: input.name,
    description: input.description,
    artifactIds: [],
    audience: input.audience,
    data: { sourceRef },
    extensions: {},
  };
}

export function findPublishedModuleArtifactV2(
  artifacts: ReadonlyMap<string, RoomArtifactV2>,
  modulePackage: Pick<ModulePackageV1, "moduleId" | "revision">,
  sourceId: string,
  kind: ModuleRoomArtifactKindV2,
  audience: AudienceV2,
): RoomArtifactV2 | undefined {
  const expected = moduleRoomSourceRefV2(modulePackage, kind, sourceId);
  return [...artifacts.values()].find((artifact) =>
    artifact.kind === kind
      && matchesModuleRoomSourceRefV2(artifact.extensions.sourceRef, expected)
      && isCompatibleModulePublicationAudienceV2(artifact.audience, audience),
  );
}

export function buildPublishedModuleArtifactV2(
  artifacts: ReadonlyMap<string, RoomArtifactV2>,
  modulePackage: Pick<ModulePackageV1, "moduleId" | "revision">,
  input: ModuleArtifactPublicationInputV2,
  createId: () => string,
): RoomArtifactV2 {
  const sourceRef = moduleRoomSourceRefV2(modulePackage, input.kind, input.sourceId);
  const existing = findPublishedModuleArtifactV2(
    artifacts,
    modulePackage,
    input.sourceId,
    input.kind,
    input.audience,
  );
  if (existing) {
    return {
      ...existing,
      revision: existing.revision + 1,
      title: input.title,
      body: input.body,
      audience: input.audience,
      // Keep imported attachments, locks, archival state, compatibility asset
      // and unrelated extensions. Only the module-authored fields are updated.
      extensions: { ...existing.extensions, sourceRef },
    };
  }
  return {
    schemaVersion: 2,
    artifactId: createId(),
    revision: 1,
    kind: input.kind,
    title: input.title,
    description: "",
    body: input.body,
    attachments: [],
    sourceEntityId: input.sourceId,
    audience: input.audience,
    locked: false,
    archived: false,
    extensions: { sourceRef },
  };
}

export function matchesModuleRoomSourceRefV2(
  candidate: unknown,
  expected: ModuleRoomSourceRefV2,
): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const value = candidate as Record<string, unknown>;
  return value.moduleId === expected.moduleId
    && value.revision === expected.revision
    && value.kind === expected.kind
    && value.id === expected.id;
}
