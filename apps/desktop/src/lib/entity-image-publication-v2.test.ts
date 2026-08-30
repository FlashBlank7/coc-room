import { describe, expect, it } from "vitest";
import type { AssetDescriptorV1, RoomEntityV2 } from "@coc-room/protocol";

import { buildEntityImagePublicationV2, publishEntityImageV2 } from "./entity-image-publication-v2";

const asset: AssetDescriptorV1 = {
  schemaVersion: 1,
  assetId: `sha256:${"e".repeat(64)}`,
  mediaType: "image/webp",
  byteLength: 4_096,
  width: 640,
  height: 480,
};

describe("buildEntityImagePublicationV2", () => {
  it.each([
    ["location", "location-background"],
    ["npc", "npc-portrait"],
    ["character", "image"],
  ] as const)("builds a %s image with the entity's exact audience", (entityKind, artifactKind) => {
    const entity = roomEntity(entityKind);
    const publication = buildEntityImagePublicationV2(entity, asset, "artifact-new-image");

    expect(publication.artifact).toMatchObject({
      artifactId: "artifact-new-image",
      kind: artifactKind,
      asset,
      sourceEntityId: entity.entityId,
      audience: { kind: "seats", seatIds: ["seat-alice"] },
    });
    expect(publication.entity).toMatchObject({
      entityId: entity.entityId,
      revision: 4,
      audience: entity.audience,
      artifactIds: ["artifact-existing", "artifact-new-image"],
      data: {
        presentedInSceneEntityIds: ["scene-foyer"],
        character: { hitPoints: 7 },
      },
      extensions: { custom: { retained: true } },
    });
    expect(entity.artifactIds).toEqual(["artifact-existing"]);
  });

  it("rejects non-image resources before a room proposal can be made", () => {
    expect(() => buildEntityImagePublicationV2(
      roomEntity("npc"),
      { ...asset, mediaType: "audio/ogg" },
      "artifact-audio",
    )).toThrow(/静态图片资源/);
  });

  it("retains locally, publishes the artifact, then appends it without widening the entity audience", async () => {
    const order: string[] = [];
    const retainAssetReference = async () => { order.push("retain"); };
    const proposals: unknown[] = [];
    const submit = async (proposal: unknown) => {
      const type = (proposal as { type: string }).type;
      order.push(type);
      proposals.push(proposal);
    };
    const entity = roomEntity("npc");

    await publishEntityImageV2({
      entity,
      asset,
      artifactId: "artifact-confirmed-image",
      retainAssetReference,
      submit,
    });

    expect(order).toEqual(["retain", "artifact.upserted", "entity.upserted"]);
    expect(proposals).toEqual([
      expect.objectContaining({
        type: "artifact.upserted",
        audience: entity.audience,
        payload: { artifact: expect.objectContaining({ audience: entity.audience }) },
      }),
      expect.objectContaining({
        type: "entity.upserted",
        audience: entity.audience,
        payload: { entity: expect.objectContaining({
          artifactIds: ["artifact-existing", "artifact-confirmed-image"],
          data: entity.data,
          extensions: entity.extensions,
        }) },
      }),
    ]);
  });
});

function roomEntity(kind: "location" | "npc" | "character"): RoomEntityV2 {
  return {
    schemaVersion: 2,
    entityId: `entity-${kind}`,
    revision: 3,
    kind,
    name: "雨夜人物",
    description: "玩家可见说明",
    artifactIds: ["artifact-existing"],
    audience: { kind: "seats", seatIds: ["seat-alice"] },
    data: {
      presentedInSceneEntityIds: ["scene-foyer"],
      character: { hitPoints: 7 },
    },
    extensions: { custom: { retained: true } },
  };
}
