import { describe, expect, it } from "vitest";

import {
  EventReplica,
  HostEventSequencer,
  commandToEventDraft,
  type ParticipantV1,
  type RoomCommandV1,
  type RoomEventV1,
} from "../src";
import { CHARACTER, HOST, PLAYER, chatEvent } from "./fixtures";

const COMMAND_ID = "10000000-0000-4000-8000-000000000001";

describe("HostEventSequencer", () => {
  it("orders events, deduplicates commands, and replays after a sequence", () => {
    const ids = [
      "20000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
    ];
    const sequencer = new HostEventSequencer("room-1", {
      createEventId: () => {
        const id = ids.shift();
        if (id === undefined) throw new Error("test IDs exhausted");
        return id;
      },
      clock: () => new Date("2026-08-27T12:00:00.000Z"),
    });

    const first = sequencer.commit({
      sender: PLAYER,
      causedByCommandId: COMMAND_ID,
      type: "chat.message",
      payload: { message: "你好", format: "plain" },
    });
    const duplicate = sequencer.commit({
      sender: PLAYER,
      causedByCommandId: COMMAND_ID,
      type: "chat.message",
      payload: { message: "重复发送", format: "plain" },
    });
    const second = sequencer.commit({
      sender: HOST,
      type: "system.notice",
      payload: { message: "开始", level: "info" },
    });

    expect(first.event.sequence).toBe(1);
    expect(duplicate).toEqual({ event: first.event, duplicate: true });
    expect(second.event.sequence).toBe(2);
    expect(sequencer.lastSequence).toBe(2);
    expect(sequencer.eventsAfter(1)).toEqual([second.event]);
  });

  it("keeps character ownership immutable at the host authority boundary", () => {
    let id = 0;
    const sequencer = new HostEventSequencer("room-1", {
      createEventId: () => `20000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
      clock: () => new Date("2026-08-27T12:00:00.000Z"),
    });
    const createCommand: RoomCommandV1 = {
      protocolVersion: 1,
      roomId: "room-1",
      commandId: "10000000-0000-4000-8000-000000000010",
      sender: PLAYER,
      sentAt: "2026-08-27T12:00:00.000Z",
      type: "character.update",
      payload: { character: CHARACTER },
    };
    sequencer.commitCommand(createCommand, { expectedSender: PLAYER });

    const attacker = { peerId: "player-2", displayName: "Attacker", role: "player" as const };
    const stolen: RoomCommandV1 = {
      ...createCommand,
      commandId: "10000000-0000-4000-8000-000000000011",
      sender: attacker,
      payload: {
        character: {
          ...CHARACTER,
          ownerPeerId: attacker.peerId,
          playerName: attacker.displayName,
        },
      },
    };
    expect(() => sequencer.commitCommand(stolen, { expectedSender: attacker })).toThrow(/owner/i);

    const keeperCorrection: RoomCommandV1 = {
      ...createCommand,
      commandId: "10000000-0000-4000-8000-000000000012",
      sender: HOST,
      payload: { character: { ...CHARACTER, notes: "Keeper correction" } },
    };
    expect(sequencer.commitCommand(keeperCorrection, { expectedSender: HOST }).event.sequence).toBe(2);
  });

  it("only reveals content from the active module revision", () => {
    let id = 0;
    const sequencer = new HostEventSequencer("room-1", {
      createEventId: () => `20000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    });
    const reveal: RoomCommandV1 = {
      protocolVersion: 1,
      roomId: "room-1",
      commandId: "10000000-0000-4000-8000-000000000020",
      sender: HOST,
      sentAt: "2026-08-27T12:00:00.000Z",
      type: "content.reveal",
      payload: {
        moduleId: "module-1",
        revision: 2,
        contentId: "clue-1",
        contentType: "clue",
        title: "A clue",
        body: "Visible text",
      },
    };
    expect(() => sequencer.commitCommand(reveal, { expectedSender: HOST })).toThrow(/active module/i);

    const switchModule: RoomCommandV1 = {
      protocolVersion: 1,
      roomId: "room-1",
      commandId: "10000000-0000-4000-8000-000000000021",
      sender: HOST,
      sentAt: "2026-08-27T12:00:00.000Z",
      type: "module.switch",
      payload: { moduleId: "module-1", revision: 2, title: "Module One" },
    };
    sequencer.commitCommand(switchModule, { expectedSender: HOST });

    expect(() =>
      sequencer.commitCommand(
        {
          ...reveal,
          commandId: "10000000-0000-4000-8000-000000000022",
          payload: { ...reveal.payload, revision: 1 },
        },
        { expectedSender: HOST },
      ),
    ).toThrow(/active module/i);
    expect(sequencer.commitCommand(reveal, { expectedSender: HOST }).event.type).toBe("content.revealed");
  });

  it("authorizes player-visible locations, character movement, NPCs, and located content", () => {
    const sequencer = worldSequencer();
    sequencer.commitCommand(switchModuleCommand(30), { expectedSender: HOST });
    sequencer.commitCommand(characterCommand(31), { expectedSender: PLAYER });

    const wrongRevision = publishLocationCommand(32);
    expect(() => sequencer.commitCommand({
      ...wrongRevision,
      payload: { ...wrongRevision.payload, revision: 2 },
    }, { expectedSender: HOST })).toThrow(/active module/i);

    sequencer.commitCommand(publishLocationCommand(33), { expectedSender: HOST });
    expect(() => sequencer.commitCommand(publishLocationCommand(330), { expectedSender: HOST }))
      .toThrow(/already published unchanged/i);
    const forgedLocationName = enterLocationCommand(34);
    expect(() => sequencer.commitCommand({
      ...forgedLocationName,
      payload: { ...forgedLocationName.payload, locationName: "伪造地点名" },
    }, { expectedSender: PLAYER })).toThrow(/location name/i);
    expect(() => sequencer.commitCommand({
      ...enterLocationCommand(35),
      sender: { peerId: "player-2", displayName: "另一位玩家", role: "player" },
    }, {
      expectedSender: { peerId: "player-2", role: "player" },
    })).toThrow(/own character/i);

    expect(sequencer.commitCommand(enterLocationCommand(36), { expectedSender: PLAYER }).event.type)
      .toBe("location.entered");
    expect(() => sequencer.commitCommand(enterLocationCommand(360), { expectedSender: PLAYER }))
      .toThrow(/already at that location/i);
    const secondLocation = publishLocationCommand(37);
    sequencer.commitCommand({
      ...secondLocation,
      payload: {
        ...secondLocation.payload,
        location: { id: "location-2", name: "后院", description: "杂草丛生。" },
      },
    }, { expectedSender: HOST });
    const hostEntry = enterLocationCommand(38);
    expect(sequencer.commitCommand({
      ...hostEntry,
      sender: HOST,
      payload: {
        ...hostEntry.payload,
        locationId: "location-2",
        locationName: "后院",
      },
    }, { expectedSender: HOST }).event.type).toBe("location.entered");
    expect(sequencer.commitCommand(publishNpcCommand(39), { expectedSender: HOST }).event.type)
      .toBe("npc.published");
    expect(() => sequencer.commitCommand(publishNpcCommand(390), { expectedSender: HOST }))
      .toThrow(/already published there unchanged/i);

    const locatedReveal = revealCommand(40);
    expect(sequencer.commitCommand({
      ...locatedReveal,
      payload: { ...locatedReveal.payload, locationId: "location-1" },
    }, { expectedSender: HOST }).event.type).toBe("content.revealed");
    const hiddenLocationReveal = revealCommand(41);
    expect(() => sequencer.commitCommand({
      ...hiddenLocationReveal,
      payload: { ...hiddenLocationReveal.payload, locationId: "location-secret" },
    }, { expectedSender: HOST })).toThrow(/not been published/i);
  });

  it("rebuilds character and published-location authority from initial events", () => {
    const first = worldSequencer();
    first.commitCommand(characterCommand(50), { expectedSender: PLAYER });
    first.commitCommand(switchModuleCommand(51), { expectedSender: HOST });
    first.commitCommand(publishLocationCommand(52), { expectedSender: HOST });

    const restored = worldSequencer(first.eventsAfter(0), 100);
    expect(restored.commitCommand(enterLocationCommand(53), { expectedSender: PLAYER }).event.type)
      .toBe("location.entered");

    const renamed = {
      ...CHARACTER,
      name: "林记者",
      updatedAt: "2026-08-27T12:30:00.000Z",
    };
    restored.commitCommand({
      ...characterCommand(54),
      payload: { character: renamed },
    }, { expectedSender: PLAYER });
    expect(() => restored.commitCommand(enterLocationCommand(55), { expectedSender: PLAYER }))
      .toThrow(/character name/i);
    const renamedEntry = enterLocationCommand(56);
    expect(() => restored.commitCommand({
      ...renamedEntry,
      payload: { ...renamedEntry.payload, characterName: renamed.name },
    }, { expectedSender: PLAYER })).toThrow(/already at that location/i);

    restored.commitCommand({
      ...switchModuleCommand(57),
      payload: { moduleId: "module-2", revision: 1, title: "第二模组" },
    }, { expectedSender: HOST });
    expect(() => restored.commitCommand(publishNpcCommand(58), { expectedSender: HOST }))
      .toThrow(/active module|not been published/i);
  });
});

describe("EventReplica", () => {
  it("accepts out-of-order events and reports gaps and duplicates", () => {
    const replica = new EventReplica("room-1");
    expect(replica.apply(chatEvent(2))).toEqual({ status: "applied", lastContiguousSequence: 0 });
    expect(replica.missingSequences()).toEqual([1]);
    expect(replica.orderedEvents()).toEqual([]);
    expect(replica.apply(chatEvent(1))).toEqual({ status: "applied", lastContiguousSequence: 2 });
    expect(replica.apply(chatEvent(1)).status).toBe("duplicate");
    expect(replica.orderedEvents().map((event) => event.sequence)).toEqual([1, 2]);
    expect(() => replica.apply(chatEvent(1, "篡改内容"))).toThrow(/different content/i);
  });
});

describe("commandToEventDraft", () => {
  it("resolves dice commands at the host", () => {
    const command: RoomCommandV1 = {
      protocolVersion: 1,
      roomId: "room-1",
      commandId: COMMAND_ID,
      sender: PLAYER,
      sentAt: "2026-08-27T12:00:00.000Z",
      type: "dice.roll",
      payload: {
        expression: "d100",
        reason: "图书馆使用",
        bonusDice: 0,
        penaltyDice: 0,
        target: 70,
        requiredDifficulty: "regular",
      },
    };
    const values = [4, 2];
    const draft = commandToEventDraft(command, {
      rng: () => values.shift() ?? 0,
    });
    expect(draft).toMatchObject({
      type: "dice.result",
      causedByCommandId: COMMAND_ID,
      payload: { result: { total: 24, check: { success: true } } },
    });
  });

  it("blocks host-only commands from players", () => {
    const command: RoomCommandV1 = {
      protocolVersion: 1,
      roomId: "room-1",
      commandId: COMMAND_ID,
      sender: PLAYER,
      sentAt: "2026-08-27T12:00:00.000Z",
      type: "module.switch",
      payload: { moduleId: "module-1", revision: 1, title: "无名祭祀书" },
    };
    expect(() => commandToEventDraft(command)).toThrow(/host/i);

    const playerLocationPublish: RoomCommandV1 = {
      ...command,
      type: "location.publish",
      payload: {
        moduleId: "module-1",
        revision: 1,
        location: { id: "location-1", name: "旧宅", description: "公开说明" },
      },
    };
    expect(() => commandToEventDraft(playerLocationPublish)).toThrow(/host/i);

    const playerNpcPublish: RoomCommandV1 = {
      ...command,
      type: "npc.publish",
      payload: {
        moduleId: "module-1",
        revision: 1,
        locationId: "location-1",
        locationName: "旧宅",
        npc: { id: "npc-1", name: "管家", description: "沉默的老人" },
      },
    };
    expect(() => commandToEventDraft(playerNpcPublish)).toThrow(/host/i);
  });

  it("rejects a forged connection role and cross-room commit", () => {
    const forged: RoomCommandV1 = {
      protocolVersion: 1,
      roomId: "other-room",
      commandId: COMMAND_ID,
      sender: HOST,
      sentAt: "2026-08-27T12:00:00.000Z",
      type: "module.switch",
      payload: { moduleId: "module-1", revision: 1, title: "无名祭祀书" },
    };
    expect(() =>
      commandToEventDraft(forged, { expectedSender: { peerId: HOST.peerId, role: "player" } }),
    ).toThrow(/identity/i);

    const sequencer = new HostEventSequencer("room-1");
    expect(() => sequencer.commit(commandToEventDraft(forged))).toThrow(/other-room/i);
  });
});

function worldSequencer(initialEvents: readonly RoomEventV1[] = [], idStart = 0): HostEventSequencer {
  let id = idStart;
  return new HostEventSequencer("room-1", {
    initialEvents,
    createEventId: () => `30000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    clock: () => new Date("2026-08-27T12:00:00.000Z"),
  });
}

function commandBase(id: number, sender: ParticipantV1 = HOST) {
  return {
    protocolVersion: 1 as const,
    roomId: "room-1",
    commandId: `10000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    sender,
    sentAt: "2026-08-27T12:00:00.000Z",
  };
}

function switchModuleCommand(id: number): Extract<RoomCommandV1, { type: "module.switch" }> {
  return {
    ...commandBase(id),
    type: "module.switch",
    payload: { moduleId: "module-1", revision: 1, title: "第一模组" },
  };
}

function characterCommand(id: number): Extract<RoomCommandV1, { type: "character.update" }> {
  return {
    ...commandBase(id, PLAYER),
    type: "character.update",
    payload: { character: CHARACTER },
  };
}

function publishLocationCommand(id: number): Extract<RoomCommandV1, { type: "location.publish" }> {
  return {
    ...commandBase(id),
    type: "location.publish",
    payload: {
      moduleId: "module-1",
      revision: 1,
      location: { id: "location-1", name: "旧宅", description: "潮湿而安静的旧宅。" },
    },
  };
}

function enterLocationCommand(id: number): Extract<RoomCommandV1, { type: "location.enter" }> {
  return {
    ...commandBase(id, PLAYER),
    type: "location.enter",
    payload: {
      moduleId: "module-1",
      revision: 1,
      locationId: "location-1",
      locationName: "旧宅",
      characterId: CHARACTER.id,
      characterName: CHARACTER.name,
    },
  };
}

function publishNpcCommand(id: number): Extract<RoomCommandV1, { type: "npc.publish" }> {
  return {
    ...commandBase(id),
    type: "npc.publish",
    payload: {
      moduleId: "module-1",
      revision: 1,
      locationId: "location-1",
      locationName: "旧宅",
      npc: { id: "npc-1", name: "管家", description: "沉默的老人。" },
    },
  };
}

function revealCommand(id: number): Extract<RoomCommandV1, { type: "content.reveal" }> {
  return {
    ...commandBase(id),
    type: "content.reveal",
    payload: {
      moduleId: "module-1",
      revision: 1,
      contentId: "clue-1",
      contentType: "clue",
      title: "泥脚印",
      body: "脚印通向地下室。",
    },
  };
}
