import { describe, expect, it } from "vitest";

import {
  deriveRoomWorldState,
  type ParticipantV1,
  type RoomEventV1,
} from "../src";
import { CHARACTER, HOST, PLAYER } from "./fixtures";

describe("deriveRoomWorldState", () => {
  it("projects the latest locations, NPC placements, character positions, and located content", () => {
    const events = worldEvents();
    const state = deriveRoomWorldState([...events].reverse());

    expect(state.activeModule).toEqual({ moduleId: "module-1", revision: 1, title: "第一模组" });
    expect(state.locations.get("location-1")).toEqual({
      id: "location-1",
      name: "旧宅",
      description: "灯已经亮了。",
    });
    expect(state.locations.size).toBe(2);
    expect(state.npcsByLocation.get("location-1")?.has("npc-1")).toBe(false);
    expect(state.npcsByLocation.get("location-2")?.get("npc-1")).toEqual({
      id: "npc-1",
      name: "老管家",
      description: "他终于开口说话。",
    });
    expect(state.currentLocationByCharacterId.get(CHARACTER.id)).toBe("location-2");
    expect(state.latestCharacters.get(CHARACTER.id)?.name).toBe(CHARACTER.name);
    expect(state.locationContent.get("location-1")).toEqual([expect.objectContaining({
      contentId: "clue-1",
      title: "新脚印",
      body: "脚印现在通向后门。",
    })]);
  });

  it("clears module-bound projections on a module switch but keeps character cards", () => {
    const events: RoomEventV1[] = [
      ...worldEvents(),
      {
        ...eventBase(12),
        type: "module.switched",
        payload: { moduleId: "module-2", revision: 3, title: "第二模组" },
      },
      {
        ...eventBase(13),
        type: "location.published",
        payload: {
          moduleId: "module-1",
          revision: 1,
          location: { id: "location-stale", name: "旧地点", description: "不应出现" },
        },
      },
    ];
    const state = deriveRoomWorldState(events);

    expect(state.activeModule).toEqual({ moduleId: "module-2", revision: 3, title: "第二模组" });
    expect(state.locations.size).toBe(0);
    expect(state.npcsByLocation.size).toBe(0);
    expect(state.currentLocationByCharacterId.size).toBe(0);
    expect(state.locationContent.size).toBe(0);
    expect(state.latestCharacters.get(CHARACTER.id)).toEqual(CHARACTER);
  });

  it("rejects duplicate sequence numbers and mixed-room histories", () => {
    const first = worldEvents()[0]!;
    expect(() => deriveRoomWorldState([first, { ...first, eventId: eventId(99) }]))
      .toThrow(/duplicate event sequence/i);
    expect(() => deriveRoomWorldState([first, {
      ...worldEvents()[1]!,
      roomId: "room-2",
    }])).toThrow(/multiple rooms/i);
  });
});

function worldEvents(): RoomEventV1[] {
  return [
    {
      ...eventBase(1, PLAYER),
      type: "character.updated",
      payload: { character: CHARACTER },
    },
    {
      ...eventBase(2),
      type: "module.switched",
      payload: { moduleId: "module-1", revision: 1, title: "第一模组" },
    },
    {
      ...eventBase(3),
      type: "location.published",
      payload: {
        moduleId: "module-1",
        revision: 1,
        location: { id: "location-1", name: "旧宅", description: "门窗紧闭。" },
      },
    },
    {
      ...eventBase(4),
      type: "location.published",
      payload: {
        moduleId: "module-1",
        revision: 1,
        location: { id: "location-2", name: "后院", description: "杂草丛生。" },
      },
    },
    {
      ...eventBase(5),
      type: "npc.published",
      payload: {
        moduleId: "module-1",
        revision: 1,
        locationId: "location-1",
        locationName: "旧宅",
        npc: { id: "npc-1", name: "管家", description: "沉默的老人。" },
      },
    },
    {
      ...eventBase(6, PLAYER),
      type: "location.entered",
      payload: {
        moduleId: "module-1",
        revision: 1,
        locationId: "location-1",
        locationName: "旧宅",
        characterId: CHARACTER.id,
        characterName: CHARACTER.name,
      },
    },
    {
      ...eventBase(7),
      type: "content.revealed",
      payload: {
        moduleId: "module-1",
        revision: 1,
        contentId: "clue-1",
        contentType: "clue",
        title: "泥脚印",
        body: "脚印通向地下室。",
        locationId: "location-1",
      },
    },
    {
      ...eventBase(8),
      type: "content.revealed",
      payload: {
        moduleId: "module-1",
        revision: 1,
        contentId: "clue-1",
        contentType: "clue",
        title: "新脚印",
        body: "脚印现在通向后门。",
        locationId: "location-1",
      },
    },
    {
      ...eventBase(9),
      type: "location.published",
      payload: {
        moduleId: "module-1",
        revision: 1,
        location: { id: "location-1", name: "旧宅", description: "灯已经亮了。" },
      },
    },
    {
      ...eventBase(10),
      type: "npc.published",
      payload: {
        moduleId: "module-1",
        revision: 1,
        locationId: "location-2",
        locationName: "后院",
        npc: { id: "npc-1", name: "老管家", description: "他终于开口说话。" },
      },
    },
    {
      ...eventBase(11, PLAYER),
      type: "location.entered",
      payload: {
        moduleId: "module-1",
        revision: 1,
        locationId: "location-2",
        locationName: "后院",
        characterId: CHARACTER.id,
        characterName: CHARACTER.name,
      },
    },
  ];
}

function eventBase(sequence: number, sender: ParticipantV1 = HOST) {
  return {
    protocolVersion: 1 as const,
    roomId: "room-1",
    eventId: eventId(sequence),
    sequence,
    sender,
    occurredAt: `2026-08-27T12:00:${String(sequence).padStart(2, "0")}.000Z`,
  };
}

function eventId(sequence: number): string {
  return `40000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}
