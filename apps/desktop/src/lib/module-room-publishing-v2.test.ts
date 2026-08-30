import { describe, expect, it, vi } from "vitest";
import type { AudienceV2, RoomArtifactV2, RoomEntityV2 } from "@coc-room/protocol";

import {
  buildPublishedModuleArtifactV2,
  buildPublishedModuleEntityV2,
  findPublishedModuleArtifactV2,
  findPublishedModuleEntityV2,
} from "./module-room-publishing-v2";

const MODULE = { moduleId: "module-butterfly", revision: 3 };
const ROOM: AudienceV2 = { kind: "room" };
const ALICE: AudienceV2 = { kind: "seats", seatIds: ["seat-alice"] };

describe("V2 module room publication snapshots", () => {
  it("updates a matching NPC without erasing room-owned data or extensions", () => {
    const existing = entity("npc-published", "npc", ALICE, {
      sourceRef: sourceRef("npc", "npc-hana"),
      presentedInSceneEntityIds: ["scene-foyer"],
      character: { hitPoints: 8, sanity: 45 },
      roomOnlyState: { disposition: "suspicious" },
    }, { "org.coc-room.npc-stats.v1": { confirmedAt: "2026-08-30T00:00:00.000Z" } });
    const createId = vi.fn(() => "npc-new");

    const updated = buildPublishedModuleEntityV2(
      new Map([[existing.entityId, existing]]),
      MODULE,
      {
        sourceId: "npc-hana",
        kind: "npc",
        name: "花小路",
        description: "她把湿伞靠在门边。",
        audience: ROOM,
      },
      createId,
    );

    expect(createId).not.toHaveBeenCalled();
    expect(updated).toMatchObject({
      entityId: existing.entityId,
      revision: 5,
      audience: ROOM,
      name: "花小路",
      description: "她把湿伞靠在门边。",
      artifactIds: ["artifact-portrait"],
      data: {
        sourceRef: sourceRef("npc", "npc-hana"),
        presentedInSceneEntityIds: ["scene-foyer"],
        character: { hitPoints: 8, sanity: 45 },
        roomOnlyState: { disposition: "suspicious" },
      },
      extensions: { "org.coc-room.npc-stats.v1": { confirmedAt: "2026-08-30T00:00:00.000Z" } },
    });
  });

  it("requires module, revision, kind, id and a non-narrowing audience to reuse an entity", () => {
    const wrongKindRef = entity("entity-wrong-ref-kind", "npc", ROOM, {
      sourceRef: sourceRef("location", "shared-id"),
    });
    const wrongRevision = entity("entity-wrong-revision", "npc", ROOM, {
      sourceRef: { ...sourceRef("npc", "shared-id"), revision: 2 },
    });
    const wouldNarrow = entity("entity-public", "npc", ROOM, {
      sourceRef: sourceRef("npc", "shared-id"),
    });

    expect(findPublishedModuleEntityV2(
      new Map([
        [wrongKindRef.entityId, wrongKindRef],
        [wrongRevision.entityId, wrongRevision],
        [wouldNarrow.entityId, wouldNarrow],
      ]),
      MODULE,
      "shared-id",
      "npc",
      ALICE,
    )).toBeUndefined();

    const targeted = entity("entity-targeted", "npc", ALICE, { sourceRef: sourceRef("npc", "shared-id") });
    expect(findPublishedModuleEntityV2(
      new Map([[targeted.entityId, targeted]]),
      MODULE,
      "shared-id",
      "npc",
      ROOM,
    )?.entityId).toBe(targeted.entityId);
  });

  it("reuses a matching clue artifact and preserves its attachments and room metadata", () => {
    const attachment = {
      schemaVersion: 1 as const,
      assetId: `sha256:${"a".repeat(64)}`,
      mediaType: "image/webp",
      byteLength: 512,
      width: 320,
      height: 200,
    };
    const existing: RoomArtifactV2 = {
      schemaVersion: 2,
      artifactId: "artifact-clue",
      revision: 6,
      kind: "clue",
      title: "旧标题",
      description: "玩家补写的说明",
      body: "旧正文",
      attachments: [attachment],
      audience: ROOM,
      locked: true,
      archived: false,
      extensions: { sourceRef: sourceRef("clue", "clue-ticket"), playerLayout: { column: 2 } },
    };
    const createId = vi.fn(() => "artifact-new");

    const updated = buildPublishedModuleArtifactV2(
      new Map([[existing.artifactId, existing]]),
      MODULE,
      {
        sourceId: "clue-ticket",
        kind: "clue",
        title: "撕破的票根",
        body: "票根背面写着十一点。",
        audience: ROOM,
      },
      createId,
    );

    expect(createId).not.toHaveBeenCalled();
    expect(updated).toMatchObject({
      artifactId: existing.artifactId,
      revision: 7,
      title: "撕破的票根",
      body: "票根背面写着十一点。",
      description: "玩家补写的说明",
      attachments: [attachment],
      locked: true,
      extensions: { sourceRef: sourceRef("clue", "clue-ticket"), playerLayout: { column: 2 } },
    });
  });

  it("does not confuse a handout and clue that share the same module source ID", () => {
    const clue: RoomArtifactV2 = {
      schemaVersion: 2,
      artifactId: "artifact-clue-shared",
      revision: 1,
      kind: "clue",
      title: "线索",
      description: "",
      body: "正文",
      attachments: [],
      audience: ROOM,
      locked: false,
      archived: false,
      extensions: { sourceRef: sourceRef("clue", "shared-content") },
    };

    expect(findPublishedModuleArtifactV2(
      new Map([[clue.artifactId, clue]]),
      MODULE,
      "shared-content",
      "handout",
      ROOM,
    )).toBeUndefined();
  });
});

function sourceRef(kind: "location" | "npc" | "clue" | "handout", id: string) {
  return { moduleId: MODULE.moduleId, revision: MODULE.revision, kind, id };
}

function entity(
  entityId: string,
  kind: "location" | "npc",
  audience: AudienceV2,
  data: Record<string, unknown>,
  extensions: Record<string, unknown> = {},
): RoomEntityV2 {
  return {
    schemaVersion: 2,
    entityId,
    revision: 4,
    kind,
    name: "旧名称",
    description: "旧描述",
    artifactIds: ["artifact-portrait"],
    audience,
    data,
    extensions,
  };
}
