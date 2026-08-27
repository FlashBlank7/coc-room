import { describe, expect, it } from "vitest";

import {
  EventReplica,
  HostEventSequencer,
  commandToEventDraft,
  type RoomCommandV1,
} from "../src";
import { HOST, PLAYER, chatEvent } from "./fixtures";

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
});

describe("EventReplica", () => {
  it("accepts out-of-order events and reports gaps and duplicates", () => {
    const replica = new EventReplica("room-1");
    expect(replica.apply(chatEvent(2))).toEqual({ status: "applied", lastContiguousSequence: 0 });
    expect(replica.missingSequences()).toEqual([1]);
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
