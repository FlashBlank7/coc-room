import type {
  Coc7Character,
  ParticipantV1,
  RoomInvitationPayloadV2,
} from "@coc-room/protocol";
import { describe, expect, it } from "vitest";

import { RoomAiJobCoordinator } from "../ai/room-ai-job-coordinator";
import { MemoryRepository, type RoomRecord } from "../data/repository";
import { saveLocalSeatSecret } from "../lib/seat-credentials";
import { RoomSessionV2 } from "./RoomSessionV2";
import { RoomTransport } from "./RoomTransport";

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

/**
 * Proves the request-approval wire flow over the real relay: the player's
 * request reaches the host coordinator and waits for KP consent, the waiting
 * notice comes back as a non-terminal status, and approve/reject each settle
 * the player promise (approve runs the AI and delivers directly).
 */
liveDescribe("character draft review over the live relay", () => {
  it("holds a remote request for approval, then approve generates and reject notifies", async () => {
    if (!relayOrigin) throw new Error("COC_ROOM_LIVE_RELAY_URL is required");
    const created = await createRelayRoom(relayOrigin, "draft-review-host-123");
    const hostRepository = new MemoryRepository();
    const playerRepository = new MemoryRepository();
    const host = createSession(hostRoomRecord(created, "seat-review-host"), "Review Keeper", hostRepository);
    const errors: string[] = [];
    host.onError = (message) => errors.push(`host: ${message}`);
    let player: RoomSessionV2 | undefined;

    try {
      await host.start();
      const invitation = await host.issueSeatInvitation("Review Player", "seat-review-player");
      await saveLocalSeatSecret(created.roomId, invitation.seatId, invitation.seatSecret);
      player = createSession(playerRoomRecord(invitation, "draft-review-player1"), "Review Player", playerRepository);
      player.onError = (message) => errors.push(`player: ${message}`);
      await player.start();
      await waitUntil(() => player?.isAuthenticated === true, errors, "player did not authenticate");

      const heldJobIds: string[] = [];
      const hostCoordinator = new RoomAiJobCoordinator({
        session: host,
        provider: "codex",
        model: "",
        executor: {
          executeCharacterDraft: async (request) => ({
            character: draftCharacter(request.ownerSeatId, request.playerName),
          }),
        },
        onHostStatus: (_seat, status) => {
          const result = status.result as { approvalRequest?: boolean } | undefined;
          if (result?.approvalRequest) heldJobIds.push(status.jobId);
        },
      });
      host.onUnhandledWireMessage = (fromSeat, message) => {
        hostCoordinator.handleWireMessage(fromSeat, message);
      };
      host.onSeatAuthenticated = (seatId) => hostCoordinator.flushOutbox(seatId);

      const playerNotices: string[] = [];
      const playerCoordinator = new RoomAiJobCoordinator({
        session: player,
        provider: "codex",
        model: "",
        onClientStatus: (status) => playerNotices.push(status.message),
      });
      player.onUnhandledWireMessage = (fromSeat, message) => {
        playerCoordinator.handleWireMessage(fromSeat, message);
      };

      // 1. Approve path: request → held for KP consent → approved → host executes → delivered.
      const approved = playerCoordinator.requestCharacterDraft(
        "1920 年代的图书馆管理员，擅长图书馆使用与聆听。",
        "Review Player",
      );
      await waitUntil(() => heldJobIds.length === 1, errors, "host did not hold the first request for approval");
      await waitUntil(
        () => playerNotices.some((notice) => notice.includes("等待 KP 同意")),
        errors,
        "player never saw the approval-wait notice",
      );
      expect(hostCoordinator.approveRequest(heldJobIds[0]!)).toBe(true);
      const character = await approved;
      expect(character.ownerPeerId).toBe(invitation.seatId);
      expect(character.playerName).toBe("Review Player");

      // 2. Reject path: the player promise fails with the keeper's reason.
      const rejected = playerCoordinator.requestCharacterDraft("第二位调查员。", "Review Player");
      rejected.catch(() => undefined);
      await waitUntil(() => heldJobIds.length === 2, errors, "host did not hold the second request");
      expect(hostCoordinator.rejectRequest(heldJobIds[1]!, "先和 KP 商量职业")).toBe(true);
      await expect(rejected).rejects.toThrow("KP 拒绝了这次 AI 车卡申请：先和 KP 商量职业");

      expect(errors).toEqual([]);
      hostCoordinator.shutdown();
      playerCoordinator.shutdown();
    } finally {
      player?.stop();
      host.stop();
    }
  }, 60_000);
});

function draftCharacter(ownerSeatId: string, playerName: string): Coc7Character {
  return {
    schemaVersion: 1,
    id: globalThis.crypto.randomUUID(),
    ownerPeerId: ownerSeatId,
    name: "陈默",
    playerName,
    occupation: "图书馆管理员",
    age: 29,
    residence: "上海",
    birthplace: "宁波",
    characteristics: { str: 45, con: 55, siz: 50, dex: 60, app: 55, int: 75, pow: 60, edu: 80, luck: 50 },
    derived: {
      hitPoints: 10,
      maxHitPoints: 10,
      magicPoints: 12,
      maxMagicPoints: 12,
      sanity: 60,
      maxSanity: 99,
      movementRate: 8,
      build: 0,
      damageBonus: "0",
    },
    skills: [{ id: "skill-library", name: "图书馆使用", baseValue: 20, value: 70, checked: false }],
    status: { temporaryInsanity: false, indefiniteInsanity: false, majorWound: false, dying: false, unconscious: false },
    inventory: [],
    background: {
      personalDescription: "安静而好奇。",
      ideologyAndBeliefs: "知识应当被守护。",
      significantPeople: "一位老馆长",
      meaningfulLocations: "闭架书库",
      treasuredPossessions: "一枚黄铜书签",
      traits: "谨慎",
      injuriesAndScars: "",
      phobiasAndManias: "",
      arcaneTomesSpellsAndArtifacts: "",
      encountersWithStrangeEntities: "",
    },
    notes: "",
    updatedAt: new Date().toISOString(),
    extensions: {},
  };
}

async function createRelayRoom(origin: string, hostPeerId: string): Promise<CreatedRelayRoom> {
  const response = await fetch(`${origin}/v1/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostPeerId }),
  });
  if (!response.ok) throw new Error(`relay room creation failed with HTTP ${response.status}`);
  return await response.json() as CreatedRelayRoom;
}

function createSession(room: RoomRecord, displayName: string, repository: MemoryRepository): RoomSessionV2 {
  const transport = new RoomTransport({
    roomId: room.id,
    token: room.inviteToken,
    relayUrl: room.relayUrl,
    participant: participant(room, displayName),
    hostPeerId: room.hostPeerId,
    forceRelay: true,
  });
  return new RoomSessionV2({ room, displayName, repository, transport });
}

function hostRoomRecord(created: CreatedRelayRoom, seatId: string): RoomRecord {
  const now = new Date().toISOString();
  return {
    id: created.roomId,
    name: "Draft Review Live Room",
    localRole: "host",
    localPeerId: created.hostPeerId,
    hostPeerId: created.hostPeerId,
    inviteToken: created.hostToken,
    joinToken: created.joinToken,
    relayUrl: created.websocketUrl,
    lastSeq: 0,
    createdAt: now,
    updatedAt: now,
    protocolVersion: 2,
    localSeatId: seatId,
    hostSeatId: seatId,
    seatCredentialVersion: 1,
  };
}

function playerRoomRecord(invitation: RoomInvitationPayloadV2, peerId: string): RoomRecord {
  const now = new Date().toISOString();
  return {
    id: invitation.roomId,
    name: "Draft Review Live Room",
    localRole: "player",
    localPeerId: peerId,
    hostPeerId: invitation.hostPeerId,
    inviteToken: invitation.relayToken,
    relayUrl: invitation.relayUrl,
    lastSeq: 0,
    createdAt: now,
    updatedAt: now,
    protocolVersion: 2,
    localSeatId: invitation.seatId,
    hostSeatId: invitation.hostSeatId,
    seatCredentialVersion: invitation.credentialVersion,
  };
}

function participant(room: RoomRecord, displayName: string): ParticipantV1 {
  return { peerId: room.localPeerId, displayName, role: room.localRole };
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  errors: string[],
  timeoutMessage: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (errors.length > 0) throw new Error(errors.join("\n"));
    if (await predicate()) return;
    await new Promise((resolvePromise) => globalThis.setTimeout(resolvePromise, 20));
  }
  throw new Error(`${timeoutMessage}; errors: ${errors.join(" | ") || "none"}`);
}
