import { describe, expect, it } from "vitest";

import {
  modulePackageSchema,
  relayCreateRoomRequestSchema,
  relayCreateRoomResponseSchema,
  relayServerEnvelopeSchema,
  relayClientEnvelopeSchema,
  roomEventSchema,
  type ModulePackageV1,
} from "../src";
import { chatEvent } from "./fixtures";

function moduleFixture(): ModulePackageV1 {
  const sourceRefs = [{ sourceId: "source-1", start: 0, end: 12, excerpt: "旧宅" }];
  return {
    schemaVersion: 1,
    moduleId: "module-1",
    revision: 1,
    metadata: {
      title: "雾中旧宅",
      authors: ["测试作者"],
      language: "zh-CN",
      summary: "一场短篇调查。",
      createdAt: "2026-08-27T10:00:00.000Z",
      updatedAt: "2026-08-27T10:00:00.000Z",
    },
    overview: "调查员受邀前往旧宅。",
    sourceDocuments: [{ id: "source-1", name: "module.md", mediaType: "text/markdown" }],
    chapters: [{ id: "chapter-1", title: "第一章", order: 0, sceneIds: ["scene-1"], notes: "" }],
    scenes: [{
      id: "scene-1",
      name: "抵达",
      description: "调查员抵达旧宅。",
      synopsis: "开场",
      locationIds: ["location-1"],
      npcIds: ["npc-1"],
      clueIds: ["clue-1"],
      handoutIds: ["handout-1"],
      suggestedCheckIds: ["check-1"],
      keeperNotes: "留意窗户。",
      sourceRefs,
    }],
    locations: [{ id: "location-1", name: "旧宅", description: "荒废建筑", aliases: [], sourceRefs }],
    npcs: [{ id: "npc-1", name: "管家", description: "沉默的老人", role: "引路人", motivation: "守护秘密", traits: [], sourceRefs }],
    clues: [{ id: "clue-1", name: "泥脚印", description: "通往地下室", revealText: "一串湿脚印。", isCore: true, sourceRefs }],
    handouts: [{ id: "handout-1", name: "信件", title: "泛黄的信", description: "未寄出的信", content: "不要打开门。", sourceRefs }],
    suggestedChecks: [{ id: "check-1", skill: "侦查", difficulty: "regular", purpose: "发现脚印", onSuccess: "发现", onFailure: "错过", sourceRefs }],
    keeperNotes: [{ id: "note-1", title: "节奏", content: "保持压迫感", relatedEntityIds: ["scene-1"], sourceRefs }],
    relations: [{ id: "relation-1", fromEntityId: "npc-1", toEntityId: "location-1", kind: "guards", description: "管家守护旧宅", sourceRefs }],
    extensions: {},
  };
}

describe("shared schemas", () => {
  it("validates versioned room events", () => {
    expect(roomEventSchema.parse(chatEvent(1)).protocolVersion).toBe(1);
    expect(roomEventSchema.safeParse({ ...chatEvent(1), protocolVersion: 2 }).success).toBe(false);
  });

  it("validates module entity references", () => {
    expect(modulePackageSchema.safeParse(moduleFixture()).success).toBe(true);
    const invalid = moduleFixture();
    invalid.scenes[0]?.locationIds.push("missing-location");
    const result = modulePackageSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes("missing-location"))).toBe(true);
    }

    const duplicateAcrossKinds = moduleFixture();
    duplicateAcrossKinds.locations[0]!.id = "scene-1";
    expect(modulePackageSchema.safeParse(duplicateAcrossKinds).success).toBe(false);
  });

  it("validates the canonical relay join envelope", () => {
    const result = relayClientEnvelopeSchema.safeParse({
      protocolVersion: 1,
      kind: "join",
      roomId: "room-12345678901",
      peerId: "host-001",
      token: "0123456789abcdef0123",
      displayName: "守秘人",
      role: "host",
    });
    expect(result.success).toBe(true);

    const legacyShape = relayClientEnvelopeSchema.safeParse({
      protocolVersion: 1,
      type: "join",
      roomId: "room-12345678901",
      peerId: "host-001",
      token: "0123456789abcdef0123",
      participant: { peerId: "someone-else", displayName: "守秘人", role: "host" },
    });
    expect(legacyShape.success).toBe(false);

    expect(relayServerEnvelopeSchema.safeParse({
      kind: "ready",
      protocolVersion: 1,
      ok: true,
      roomId: "room-12345678901",
      self: { peerId: "host-001", displayName: "守秘人", role: "host", status: "online" },
      peers: [],
    }).success).toBe(true);
  });

  it("validates relay room creation with a reserved host peer ID", () => {
    expect(relayCreateRoomRequestSchema.safeParse({
      hostPeerId: "host-peer",
    }).success).toBe(true);
    expect(relayCreateRoomRequestSchema.safeParse({
      hostPeerId: "short",
    }).success).toBe(false);

    const response = {
      protocolVersion: 1,
      roomId: "room-12345678901",
      hostPeerId: "host-peer",
      hostToken: "h".repeat(32),
      joinToken: "j".repeat(32),
      websocketUrl: "wss://relay.example/v1/rooms/room-12345678901/ws",
    };
    expect(relayCreateRoomResponseSchema.safeParse(response).success).toBe(true);
    expect(relayCreateRoomResponseSchema.safeParse({
      ...response,
      joinToken: response.hostToken,
    }).success).toBe(false);
  });
});
