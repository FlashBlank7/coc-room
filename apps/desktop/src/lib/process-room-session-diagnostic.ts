import type { RoomEventV1, ParticipantV1 } from "@coc-room/protocol";
import type { LocalRepository, RoomRecord } from "../data/repository";
import { RoomSession } from "../network/RoomSession";
import type { ConnectionPath } from "../network/RoomTransport";
import {
  type NetworkSmokeRendezvous,
} from "./process-network-diagnostic";
import { createRelayRoom } from "./network-diagnostic";
import type { NetworkProcessRole } from "./process-network-diagnostic";

export type RoomSessionSmokeMode = "session-direct" | "session-relay";

export interface ProcessRoomSessionDiagnosticOptions {
  relayOrigin: string;
  mode: RoomSessionSmokeMode;
  role: NetworkProcessRole;
  runId: string;
  repository: LocalRepository;
  publishRendezvous(rendezvous: NetworkSmokeRendezvous): Promise<void>;
  readRendezvous(): Promise<NetworkSmokeRendezvous | null>;
}

export interface ProcessRoomSessionDiagnosticResult {
  mode: RoomSessionSmokeMode;
  role: NetworkProcessRole;
  runId: string;
  path: Exclude<ConnectionPath, "connecting" | "offline">;
  events: RoomEventV1[];
  duplicateWasIdempotent: true;
  reconnectReplayVerified: true;
  cleanupVerified: true;
  durationMs: number;
}

const WAIT_MS = 30_000;
const OFFLINE_SETTLE_MS = 1_500;

/** Exercises the real RoomSession, SQLite repository, transport, and replay path. */
export async function runProcessRoomSessionDiagnostic(
  options: ProcessRoomSessionDiagnosticOptions,
): Promise<ProcessRoomSessionDiagnosticResult> {
  const startedAt = performance.now();
  const participants = processParticipants(options.runId);
  const roomInfo = options.role === "host"
    ? await createHostRoom(options, participants.host.peerId)
    : await waitForRendezvous(options);
  assertRendezvous(roomInfo.rendezvous, options);

  const room = createRoomRecord(options, roomInfo.rendezvous, participants, roomInfo.hostToken ?? "");
  const expectedPath = options.mode === "session-direct" ? "direct" : "relay";
  const chatMessage = `session-chat-${options.runId}`;
  const offlineMessage = `session-replay-${options.runId}`;
  const chatCommandId = globalThis.crypto.randomUUID();
  let session: RoomSession | undefined;
  let events: RoomEventV1[] = [];
  let counterpartPresent = false;
  let sawCounterpart = false;
  let path: ConnectionPath = "connecting";
  let reconnectPresent = false;
  let offlineEventCommitted = false;
  const errors: string[] = [];
  const counterpartPeerId = options.role === "host" ? participants.player.peerId : participants.host.peerId;

  const attach = (nextSession: RoomSession): void => {
    session = nextSession;
    nextSession.onError = (message) => errors.push(message);
    nextSession.onEvents = (nextEvents) => { events = nextEvents; };
    nextSession.onPathChange = (peerId, nextPath) => {
      if (peerId === counterpartPeerId) path = nextPath;
    };
    nextSession.onPresence = (present) => {
      counterpartPresent = present.some(({ peerId }) => peerId === counterpartPeerId);
      if (counterpartPresent) {
        sawCounterpart = true;
        reconnectPresent = true;
      } else if (options.role === "host" && sawCounterpart) {
        reconnectPresent = false;
      }
    };
  };

  try {
    attach(new RoomSession({
      room,
      displayName: options.role === "host" ? participants.host.displayName : participants.player.displayName,
      relayUrl: roomInfo.rendezvous.websocketUrl,
      repository: options.repository,
      forceRelay: options.mode === "session-relay",
    }));
    await session!.start();
    await waitUntil(() => counterpartPresent, errors, "RoomSession peers did not rendezvous");
    if (options.mode === "session-direct" || options.role === "host") {
      await waitUntil(
        () => path === expectedPath,
        errors,
        `RoomSession did not establish the ${expectedPath} path`,
      );
    }

    if (options.role === "player") {
      await session!.submit("chat.send", { message: chatMessage, format: "plain" }, chatCommandId);
      await waitUntil(() => events.length >= 2, errors, "RoomSession chat and dice events did not converge");
      await session!.submit("chat.send", { message: chatMessage, format: "plain" }, chatCommandId);
      await delay(750);
      const duplicateWasIdempotent = await options.repository.saveEvent(events[0]!);
      if (duplicateWasIdempotent) throw new Error("SQLite accepted a duplicate RoomSession event");
      session!.stop();
      await delay(OFFLINE_SETTLE_MS);
      attach(new RoomSession({
        room,
        displayName: participants.player.displayName,
        relayUrl: roomInfo.rendezvous.websocketUrl,
        repository: options.repository,
        forceRelay: options.mode === "session-relay",
      }));
      await session!.start();
      await waitUntil(
        () => events.length >= 3,
        errors,
        "RoomSession reconnect did not replay the missing event",
      );
      if (!hasExpectedEvents(events, chatMessage, offlineMessage)) {
        throw new Error("reconnected SQLite event log did not contain the expected chat, dice, and replay events");
      }
      return result(options, expectedPath, events, startedAt);
    }

    await waitUntil(
      () => events.some((event) => event.type === "chat.message" && event.payload.message === chatMessage),
      errors,
      "host did not receive the player chat",
    );
    await session!.submit("dice.roll", {
      expression: "d100",
      reason: `session-dice-${options.runId}`,
      bonusDice: 0,
      penaltyDice: 0,
    });
    await waitUntil(() => events.length >= 2, errors, "host did not commit the authoritative dice event");
    const duplicateWasIdempotent = await options.repository.saveEvent(events[0]!);
    if (duplicateWasIdempotent) throw new Error("SQLite accepted a duplicate RoomSession event");
    await waitUntil(
      () => sawCounterpart && !counterpartPresent,
      errors,
      "host did not observe the player disconnect before replay",
    );
    await session!.submit("chat.send", { message: offlineMessage, format: "plain" });
    offlineEventCommitted = true;
    await waitUntil(() => events.length >= 3, errors, "host did not persist the offline replay event");
    await waitUntil(() => reconnectPresent, errors, "player did not reconnect for replay verification");
    if (!offlineEventCommitted || !hasExpectedEvents(events, chatMessage, offlineMessage)) {
      throw new Error("host event log was incomplete after reconnect");
    }
    return result(options, expectedPath, events, startedAt);
  } finally {
    session?.stop();
    await options.repository.deleteRoom(room.id);
    if ((await options.repository.listRooms()).some((candidate) => candidate.id === room.id)
      || (await options.repository.listEvents(room.id)).length !== 0) {
      throw new Error("RoomSession smoke cleanup left its room in SQLite");
    }
  }
}

function result(
  options: ProcessRoomSessionDiagnosticOptions,
  expectedPath: Exclude<ConnectionPath, "connecting" | "offline">,
  events: RoomEventV1[],
  startedAt: number,
): ProcessRoomSessionDiagnosticResult {
  if (options.role === "player" && events.length !== 3) {
    throw new Error(`reconnected RoomSession log has ${events.length} events instead of 3`);
  }
  return {
    mode: options.mode,
    role: options.role,
    runId: options.runId,
    path: expectedPath,
    events,
    duplicateWasIdempotent: true,
    reconnectReplayVerified: true,
    cleanupVerified: true,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

function hasExpectedEvents(events: RoomEventV1[], chatMessage: string, offlineMessage: string): boolean {
  const first = events[0];
  const second = events[1];
  const third = events[2];
  return events.length >= 3
    && first?.sequence === 1
    && first.type === "chat.message"
    && first.payload.message === chatMessage
    && second?.sequence === 2
    && second.type === "dice.result"
    && third?.sequence === 3
    && third.type === "chat.message"
    && third.payload.message === offlineMessage;
}

function processParticipants(runId: string): { host: ParticipantV1; player: ParticipantV1 } {
  return {
    host: { peerId: `session-host-${runId}`, displayName: "Session smoke host", role: "host" },
    player: { peerId: `session-player-${runId}`, displayName: "Session smoke player", role: "player" },
  };
}

function createRoomRecord(
  options: ProcessRoomSessionDiagnosticOptions,
  rendezvous: NetworkSmokeRendezvous,
  participants: { host: ParticipantV1; player: ParticipantV1 },
  hostToken: string,
): RoomRecord {
  const now = new Date().toISOString();
  const isHost = options.role === "host";
  return {
    id: rendezvous.roomId,
    name: "RoomSession process smoke",
    localRole: options.role,
    localPeerId: isHost ? participants.host.peerId : participants.player.peerId,
    hostPeerId: participants.host.peerId,
    inviteToken: isHost ? hostToken : rendezvous.joinToken,
    joinToken: isHost ? rendezvous.joinToken : undefined,
    relayUrl: rendezvous.websocketUrl,
    lastSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function createHostRoom(
  options: ProcessRoomSessionDiagnosticOptions,
  hostPeerId: string,
): Promise<{ rendezvous: NetworkSmokeRendezvous; hostToken: string }> {
  const created = await createRelayRoom(options.relayOrigin, hostPeerId);
  const rendezvous: NetworkSmokeRendezvous = {
    protocolVersion: 1,
    runId: options.runId,
    mode: options.mode,
    roomId: created.roomId,
    hostPeerId: created.hostPeerId,
    joinToken: created.joinToken,
    websocketUrl: created.websocketUrl,
  };
  await options.publishRendezvous(rendezvous);
  return { rendezvous, hostToken: created.hostToken };
}

async function waitForRendezvous(
  options: ProcessRoomSessionDiagnosticOptions,
): Promise<{ rendezvous: NetworkSmokeRendezvous; hostToken?: undefined }> {
  let rendezvous: NetworkSmokeRendezvous | null = null;
  await waitUntil(
    () => rendezvous !== null,
    [],
    "RoomSession smoke rendezvous was not published",
    async () => { rendezvous = await options.readRendezvous(); },
  );
  if (!rendezvous) throw new Error("RoomSession smoke rendezvous is empty");
  return { rendezvous };
}

function assertRendezvous(
  rendezvous: NetworkSmokeRendezvous,
  options: Pick<ProcessRoomSessionDiagnosticOptions, "mode" | "runId">,
): void {
  if (rendezvous.protocolVersion !== 1 || rendezvous.mode !== options.mode || rendezvous.runId !== options.runId) {
    throw new Error("RoomSession smoke rendezvous does not match this run");
  }
}

async function waitUntil(
  predicate: () => boolean,
  errors: string[],
  timeoutMessage: string,
  beforeCheck?: () => Promise<void>,
): Promise<void>;
async function waitUntil(
  predicate: () => boolean,
  errors: string[],
  timeoutMessage: string,
  timeoutMs: number,
  beforeCheck?: () => Promise<void>,
): Promise<void>;
async function waitUntil(
  predicate: () => boolean,
  errors: string[],
  timeoutMessage: string,
  timeoutMsOrBefore?: number | (() => Promise<void>),
  beforeCheck?: () => Promise<void>,
): Promise<void> {
  const timeoutMs = typeof timeoutMsOrBefore === "number" ? timeoutMsOrBefore : WAIT_MS;
  const check = typeof timeoutMsOrBefore === "function" ? timeoutMsOrBefore : beforeCheck;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (errors.length > 0) throw new Error(errors.join("\n"));
    if (check) await check();
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(timeoutMessage);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}
