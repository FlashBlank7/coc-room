import type {
  AssetDescriptorV1,
  RoomArtifactV2,
  RoomEntityV2,
  RoomEventProposalV2,
} from "@coc-room/protocol";

export type ImageBearingEntityKindV2 = Extract<RoomEntityV2["kind"], "location" | "npc" | "character">;

export interface EntityImagePublicationV2 {
  readonly artifact: RoomArtifactV2;
  readonly entity: RoomEntityV2;
}

export interface PublishEntityImageV2Input {
  readonly entity: RoomEntityV2;
  readonly asset: AssetDescriptorV1;
  readonly artifactId: string;
  readonly retainAssetReference: (input: {
    assetId: string;
    ownerType: "artifact";
    ownerId: string;
    ownerRevision: number;
    slot: string;
  }) => Promise<void>;
  readonly submit: (proposal: RoomEventProposalV2) => Promise<unknown>;
}

/**
 * Local asset records may carry bookkeeping fields beyond the wire schema
 * (e.g. the .cocmod store keeps an `extension`); events must embed exactly
 * the strict AssetDescriptorV1 shape or the reducer rejects the whole submit.
 */
export function toWireAssetDescriptorV1(asset: AssetDescriptorV1): AssetDescriptorV1 {
  return {
    schemaVersion: asset.schemaVersion,
    assetId: asset.assetId,
    mediaType: asset.mediaType,
    byteLength: asset.byteLength,
    ...(asset.width === undefined ? {} : { width: asset.width }),
    ...(asset.height === undefined ? {} : { height: asset.height }),
    ...(asset.durationMs === undefined ? {} : { durationMs: asset.durationMs }),
  };
}

/** Builds both confirmed room snapshots without mutating the current entity. */
export function buildEntityImagePublicationV2(
  current: RoomEntityV2,
  asset: AssetDescriptorV1,
  artifactId: string,
): EntityImagePublicationV2 {
  if (!isImageBearingEntityV2(current)) {
    throw new Error("只有已发布的地点、人物或调查员可以绑定图片");
  }
  if (!asset.mediaType.startsWith("image/")) {
    throw new Error("实体图片必须是已经规范化的静态图片资源");
  }
  const kind = entityImageArtifactKindV2(current.kind);
  const wireAsset = toWireAssetDescriptorV1(asset);
  const artifact: RoomArtifactV2 = {
    schemaVersion: 2,
    artifactId,
    revision: 1,
    kind,
    title: current.kind === "npc" ? `${current.name}肖像` : current.kind === "location" ? `${current.name}背景` : `${current.name}形象`,
    description: "由 KP 从本地资源库确认发布的图片",
    body: "",
    attachments: [],
    asset: wireAsset,
    sourceEntityId: current.entityId,
    // The artifact is never broader than its owning entity. Using the exact
    // audience also lets the entity safely reference it in the V2 reducer.
    audience: current.audience,
    locked: false,
    archived: false,
    extensions: { source: "keeper-local-upload" },
  };
  return {
    artifact,
    entity: {
      ...current,
      revision: current.revision + 1,
      artifactIds: [...current.artifactIds, artifactId],
      data: { ...current.data },
      extensions: { ...current.extensions },
    },
  };
}

/** Runs only after UI confirmation. The artifact must be authoritative before
 * an entity may reference it, so the two proposals are deliberately ordered. */
export async function publishEntityImageV2({
  entity,
  asset,
  artifactId,
  retainAssetReference,
  submit,
}: PublishEntityImageV2Input): Promise<EntityImagePublicationV2> {
  const publication = buildEntityImagePublicationV2(entity, asset, artifactId);
  await retainAssetReference({
    assetId: asset.assetId,
    ownerType: "artifact",
    ownerId: artifactId,
    ownerRevision: 1,
    slot: "entity.visual",
  });
  await submit({
    type: "artifact.upserted",
    audience: entity.audience,
    payload: { artifact: publication.artifact },
  });
  await submit({
    type: "entity.upserted",
    audience: entity.audience,
    payload: { entity: publication.entity },
  });
  return publication;
}

export function hasPublishedEntityImageV2(
  entity: Pick<RoomEntityV2, "artifactIds">,
  artifacts: ReadonlyMap<string, RoomArtifactV2>,
): boolean {
  return entity.artifactIds.some((artifactId) => {
    const artifact = artifacts.get(artifactId);
    if (!artifact || artifact.archived) return false;
    const assets = [...artifact.attachments, ...(artifact.asset ? [artifact.asset] : [])];
    return assets.some(({ mediaType }) => mediaType.startsWith("image/"));
  });
}

export function isImageBearingEntityV2(
  entity: RoomEntityV2,
): entity is RoomEntityV2 & { kind: ImageBearingEntityKindV2 } {
  return entity.kind === "location" || entity.kind === "npc" || entity.kind === "character";
}

function entityImageArtifactKindV2(kind: ImageBearingEntityKindV2): "location-background" | "npc-portrait" | "image" {
  if (kind === "location") return "location-background";
  if (kind === "npc") return "npc-portrait";
  return "image";
}
