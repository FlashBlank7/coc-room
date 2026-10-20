import {
  isAudienceSubsetV2,
  isSameAudienceV2,
  type AudienceV2,
  type BoardItemV1,
  type BoardPointV1,
  type BoardV1,
  type ModulePackageV1,
  type ModuleSceneV1,
  type RoomEntityV2,
  type RoomWorldStateV2,
} from "@coc-room/protocol";

import type { RoomSessionV2 } from "../../../network/RoomSessionV2";

interface ModuleSceneDropPayloadV1 {
  readonly kind: "module-scene";
  readonly moduleId: string;
  readonly revision: number;
  readonly sceneId: string;
}

export interface SceneEntryV2 {
  readonly scene: RoomEntityV2;
  readonly sceneItem: BoardItemV1;
  readonly characters: ReadonlyArray<{ entity: RoomEntityV2; item: BoardItemV1 }>;
}

export interface PendingModuleSceneEntryV2 {
  readonly entry: SceneEntryV2;
  readonly sourceId: string;
}

export async function handleModuleSceneDropV2(
  session: RoomSessionV2,
  modulePackage: ModulePackageV1,
  boardId: string,
  payloadText: string,
  point: BoardPointV1,
): Promise<void> {
  const payload = parseModuleSceneDrop(payloadText);
  if (payload.moduleId !== modulePackage.moduleId || payload.revision !== modulePackage.revision) {
    throw new Error("这个场景来自另一份模组，请从当前模组列表重新拖入");
  }
  const scene = modulePackage.scenes.find(({ id }) => id === payload.sceneId);
  if (!scene) throw new Error("这项场景已经不在当前模组中，请重新选择");
  await placeModuleSceneOnBoardV2(session, modulePackage, scene, boardId, point);
}

export function detectSceneEntriesV2(world: RoomWorldStateV2, board?: BoardV1): SceneEntryV2[] {
  if (!board) return [];
  const resolved = board.items.flatMap((item) => {
    if (item.reference.kind !== "entity") return [];
    const entity = world.entities.get(item.reference.entityId);
    return entity ? [{ entity, item }] : [];
  });
  const scenes = resolved.filter(({ entity }) => entity.kind === "scene");
  const characters = resolved.filter(({ entity }) => entity.kind === "character");
  return scenes.map(({ entity: scene, item: sceneItem }) => ({
    scene,
    sceneItem,
    characters: characters.filter(({ item }) => pointInsideItem(item.position, sceneItem, board)),
  }));
}

export function pendingModuleSceneEntriesV2(
  world: RoomWorldStateV2,
  modulePackage: ModulePackageV1,
  board?: BoardV1,
): PendingModuleSceneEntryV2[] {
  const activeSourceId = world.activeSceneEntityId
    ? moduleSceneSourceId(world.entities.get(world.activeSceneEntityId), modulePackage)
    : undefined;
  return detectSceneEntriesV2(world, board).flatMap((entry) => {
    const sourceId = moduleSceneSourceId(entry.scene, modulePackage);
    return entry.characters.length > 0 && sourceId !== undefined && sourceId !== activeSourceId
      ? [{ entry, sourceId }]
      : [];
  });
}

function moduleSceneSourceId(
  entity: RoomEntityV2 | undefined,
  modulePackage: ModulePackageV1,
): string | undefined {
  if (!entity || entity.kind !== "scene") return undefined;
  const sourceRef = entity.data.sourceRef;
  if (
    !isRecord(sourceRef)
    || sourceRef.moduleId !== modulePackage.moduleId
    || sourceRef.revision !== modulePackage.revision
    || sourceRef.kind !== "scene"
    || typeof sourceRef.id !== "string"
  ) return undefined;
  return modulePackage.scenes.some(({ id }) => id === sourceRef.id)
    ? sourceRef.id
    : undefined;
}

export async function placeModuleSceneOnBoardV2(
  session: RoomSessionV2,
  modulePackage: ModulePackageV1,
  scene: ModuleSceneV1,
  boardId: string,
  point: BoardPointV1,
): Promise<void> {
  const board = session.world.boards.get(boardId);
  if (!board || board.archived) throw new Error("当前画面已经关闭或被 KP 收起，请选择仍在使用的画面");
  const entity = await ensureModuleEntityV2(session, modulePackage, {
    sourceId: scene.id,
    kind: "scene",
    name: scene.name,
    description: "",
    audience: board.audience,
  });
  await placeEntityOnBoardV2(session, boardId, entity, point);
}

export async function presentModuleSceneV2(
  session: RoomSessionV2,
  modulePackage: ModulePackageV1,
  scene: ModuleSceneV1,
  publicOpening: string,
): Promise<RoomEntityV2> {
  const description = publicOpening.trim();
  if (!description) throw new Error("请先写下玩家能看到的场景描述");

  const audience = { kind: "room" } as const;
  const existing = findModuleEntityV2(session.world, modulePackage, scene.id, "scene", audience);
  const entity: RoomEntityV2 = existing
    ? { ...existing, revision: existing.revision + 1, name: scene.name, description }
    : {
        schemaVersion: 2,
        entityId: crypto.randomUUID(),
        revision: 1,
        kind: "scene",
        name: scene.name,
        description,
        artifactIds: [],
        audience,
        data: { sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "scene", id: scene.id } },
        extensions: {},
      };

  if (!existing || existing.name !== entity.name || existing.description !== entity.description) {
    await session.submitConfirmed({ type: "entity.upserted", audience, payload: { entity } });
  }
  if (session.world.activeSceneEntityId !== entity.entityId) {
    await session.submitConfirmed({ type: "scene.focused", audience, payload: { sceneEntityId: entity.entityId } });
  }
  return session.world.entities.get(entity.entityId) ?? entity;
}

export async function ensureModuleEntityV2(
  session: RoomSessionV2,
  modulePackage: ModulePackageV1,
  input: { sourceId: string; kind: "scene" | "location" | "npc"; name: string; description: string; audience: AudienceV2; data?: RoomEntityV2["data"] },
): Promise<RoomEntityV2> {
  const existing = [...session.world.entities.values()].find((entity) => {
    const sourceRef = entity.data.sourceRef;
    return isRecord(sourceRef)
      && sourceRef.moduleId === modulePackage.moduleId
      && sourceRef.revision === modulePackage.revision
      && sourceRef.kind === input.kind
      && sourceRef.id === input.sourceId
      && isSameAudienceV2(entity.audience, input.audience);
  });
  if (existing) return existing;
  const entity: RoomEntityV2 = {
    schemaVersion: 2,
    entityId: crypto.randomUUID(),
    revision: 1,
    kind: input.kind,
    name: input.name,
    description: input.description,
    artifactIds: [],
    audience: input.audience,
    data: { ...input.data, sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: input.kind, id: input.sourceId } },
    extensions: {},
  };
  await session.submitConfirmed({ type: "entity.upserted", audience: entity.audience, payload: { entity } });
  return session.world.entities.get(entity.entityId) ?? entity;
}

export async function placeEntityOnBoardV2(
  session: RoomSessionV2,
  boardId: string,
  entity: RoomEntityV2,
  point: BoardPointV1,
  locked = false,
  allowMultipleRepresentations = false,
): Promise<void> {
  const board = session.world.boards.get(boardId);
  if (!board || board.archived) throw new Error("当前画面已经关闭或被 KP 收起，请选择仍在使用的画面");
  if (!isAudienceSubsetV2(board.audience, entity.audience)) throw new Error("这项内容只给部分人看，不能放到所有人可见的画面上");
  const existing = allowMultipleRepresentations
    ? undefined
    : board.items.find((item) => item.reference.kind === "entity" && item.reference.entityId === entity.entityId);
  const item: BoardItemV1 = existing ? { ...existing, position: clampBoardPoint(point, board) } : {
    schemaVersion: 1,
    itemId: crypto.randomUUID(),
    reference: { kind: "entity", entityId: entity.entityId },
    label: entity.name,
    position: clampBoardPoint(point, board),
    size: entity.kind === "scene" ? { width: 420, height: 260 } : entity.kind === "character" ? { width: 130, height: 130 } : entity.kind === "npc" ? { width: 150, height: 150 } : { width: 280, height: 160 },
    rotationDegrees: 0,
    scale: 1,
    zIndex: board.items.length,
    locked,
    audience: board.audience,
    extensions: { roomRole: `${entity.kind}-token` },
  };
  await session.submitConfirmed({ type: "board.item.upserted", audience: board.audience, payload: { boardId, boardRevision: board.revision + 1, item } });
}

export function findModuleEntityV2(
  world: RoomWorldStateV2,
  modulePackage: ModulePackageV1,
  sourceId: string,
  kind: "scene" | "location" | "npc",
  audience: AudienceV2,
): RoomEntityV2 | undefined {
  return [...world.entities.values()].find((entity) => {
    const sourceRef = entity.data.sourceRef;
    return entity.kind === kind
      && isRecord(sourceRef)
      && sourceRef.moduleId === modulePackage.moduleId
      && sourceRef.revision === modulePackage.revision
      && sourceRef.kind === kind
      && sourceRef.id === sourceId
      && isSameAudienceV2(entity.audience, audience);
  });
}

export function clampBoardPoint(point: BoardPointV1, board: BoardV1): BoardPointV1 {
  return {
    x: Math.max(0, Math.min(board.logicalSize.width, Math.round(point.x))),
    y: Math.max(0, Math.min(board.logicalSize.height, Math.round(point.y))),
  };
}

function parseModuleSceneDrop(value: string): ModuleSceneDropPayloadV1 {
  let candidate: unknown;
  try { candidate = JSON.parse(value); } catch { throw new Error("没有识别出拖入的场景，请从场景列表重新拖动"); }
  if (!isRecord(candidate) || candidate.kind !== "module-scene" || typeof candidate.moduleId !== "string" || !Number.isInteger(candidate.revision) || typeof candidate.sceneId !== "string") {
    throw new Error("没有识别出拖入的场景，请从场景列表重新拖动");
  }
  return candidate as unknown as ModuleSceneDropPayloadV1;
}

function pointInsideItem(point: BoardPointV1, container: BoardItemV1, board: BoardV1) {
  const size = container.size ?? { width: board.logicalSize.width / 7, height: board.logicalSize.height / 8 };
  return Math.abs(point.x - container.position.x) <= size.width * container.scale / 2
    && Math.abs(point.y - container.position.y) <= size.height * container.scale / 2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
