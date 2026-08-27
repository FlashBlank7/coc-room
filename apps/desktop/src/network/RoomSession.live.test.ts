import type { ParticipantV1, RoomEventV1 } from "@coc-room/protocol";
import { describe, expect, it } from "vitest";

import { MemoryRepository, type RoomRecord } from "../data/repository";
import { RoomSession } from "./RoomSession";

const relayOrigin = process.env.COC_ROOM_LIVE_RELAY_URL?.replace(/\/$/u, "");
const liveDescribe = relayOrigin ? describe : describe.skip;

interface CreatedRelayRoom {
  protocolVersion: 1;
  roomId: string;
  hostPeerId: string;
  hostToken: string;
  joinToken: string;
  websocketUrl: string;
}

liveDescribe("RoomSession live forced-relay integration", () => {
  it("keeps two real sessions consistent across relay fragmentation and reconnect", async () => {
    if (!relayOrigin) throw new Error("COC_ROOM_LIVE_RELAY_URL is required");
    if (typeof WebSocket === "undefined") {
      throw new Error("This smoke requires the WebSocket implementation bundled with Node 22+");
    }

    const hostPeerId = "live-host-123456";
    const playerPeerId = "live-player-1234";
    const created = await createRelayRoom(relayOrigin, hostPeerId);
    const hostRepository = new MemoryRepository();
    const playerRepository = new MemoryRepository();
    const host = createSession(
      roomRecord(created, "host", hostPeerId),
      "Live Keeper",
      hostRepository,
    );
    let player = createSession(
      roomRecord(created, "player", playerPeerId),
      "Live Investigator",
      playerRepository,
    );
    const errors: string[] = [];
    let hostPresence: ParticipantV1[] = [];
    host.onError = (message) => errors.push(`host: ${message}`);
    player.onError = (message) => errors.push(`player: ${message}`);
    host.onPresence = (participants) => { hostPresence = participants; };

    try {
      await host.start();
      await player.start();
      await waitUntil(
        () => hostPresence.some(({ peerId }) => peerId === playerPeerId),
        errors,
        "host did not observe the player",
      );

      await player.submit("chat.send", { message: "live relay hello", format: "plain" });
      await waitForEventCount(hostRepository, created.roomId, 1, errors);
      await host.submit("dice.roll", {
        expression: "d100",
        reason: "Live relay Spot Hidden",
        bonusDice: 0,
        penaltyDice: 0,
        target: 65,
        requiredDifficulty: "regular",
      });
      await host.submit("module.switch", {
        moduleId: "live-module",
        revision: 1,
        title: "Live Module",
      });
      const largeUnicodeBody = "见🦋".repeat(12_000);
      await host.submit("content.reveal", {
        moduleId: "live-module",
        revision: 1,
        contentId: "live-handout",
        contentType: "handout",
        title: "Large live handout",
        body: largeUnicodeBody,
      });
      await waitForEventCount(playerRepository, created.roomId, 4, errors);

      const beforeDisconnect = await playerRepository.listEvents(created.roomId);
      expect(beforeDisconnect.at(-1)).toMatchObject({
        type: "content.revealed",
        payload: { body: largeUnicodeBody },
      });

      player.stop();
      await waitUntil(
        () => !hostPresence.some(({ peerId }) => peerId === playerPeerId),
        errors,
        "host did not observe the player leaving",
      );
      await host.submit("chat.send", {
        message: "event created while the player was offline",
        format: "plain",
      });
      await waitForEventCount(hostRepository, created.roomId, 5, errors);

      player = createSession(
        roomRecord(created, "player", playerPeerId),
        "Live Investigator",
        playerRepository,
      );
      player.onError = (message) => errors.push(`reconnected player: ${message}`);
      await player.start();
      await waitForEventCount(playerRepository, created.roomId, 5, errors);

      const hostEvents = await hostRepository.listEvents(created.roomId);
      const playerEvents = await playerRepository.listEvents(created.roomId);
      expect(playerEvents).toEqual(hostEvents);
      expect(playerEvents.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(errors).toEqual([]);
    } finally {
      player.stop();
      host.stop();
    }
  }, 30_000);
});

async function createRelayRoom(origin: string, hostPeerId: string): Promise<CreatedRelayRoom> {
  const response = await fetch(`${origin}/v1/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostPeerId }),
  });
  if (!response.ok) throw new Error(`relay room creation failed with HTTP ${response.status}`);
  return await response.json() as CreatedRelayRoom;
}

function createSession(
  room: RoomRecord,
  displayName: string,
  repository: MemoryRepository,
): RoomSession {
  return new RoomSession({
    room,
    displayName,
    relayUrl: room.relayUrl,
    repository,
    forceRelay: true,
  });
}

function roomRecord(
  created: CreatedRelayRoom,
  role: "host" | "player",
  localPeerId: string,
): RoomRecord {
  const now = "2026-08-28T00:00:00.000Z";
  return {
    id: created.roomId,
    name: "Live Relay Smoke",
    localRole: role,
    localPeerId,
    hostPeerId: created.hostPeerId,
    inviteToken: role === "host" ? created.hostToken : created.joinToken,
    ...(role === "host" ? { joinToken: created.joinToken } : {}),
    relayUrl: created.websocketUrl,
    lastSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function waitForEventCount(
  repository: MemoryRepository,
  roomId: string,
  expectedCount: number,
  errors: string[],
): Promise<RoomEventV1[]> {
  let events: RoomEventV1[] = [];
  await waitUntil(async () => {
    events = await repository.listEvents(roomId);
    return events.length === expectedCount;
  }, errors, `event log did not reach ${expectedCount} events`);
  return events;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  errors: string[],
  timeoutMessage: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (errors.length > 0) throw new Error(errors.join("\n"));
    if (await predicate()) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  }
  throw new Error(`${timeoutMessage}; errors: ${errors.join(" | ") || "none"}`);
}
