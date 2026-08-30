import { describe, expect, it, vi } from "vitest";
import type { Coc7Character, SeatV2 } from "@coc-room/protocol";
import type { RoomSessionV2 } from "../network/RoomSessionV2";
import type { RoomWireMessage } from "../network/RoomTransport";
import {
  RoomAiJobCoordinator,
  type CharacterDraftExecutionRequest,
  type RoomAiDraftExecutor,
} from "./room-ai-job-coordinator";

const hostSeat: SeatV2 = {
  seatId: "seat-host-0001",
  role: "host",
  displayName: "KP",
  extensions: {},
};
const playerSeat: SeatV2 = {
  seatId: "seat-player-0001",
  role: "player",
  displayName: "Alice",
  extensions: {},
};

describe("RoomAiJobCoordinator", () => {
  it("keeps a player result transient and resolves only after a host status", async () => {
    let sent: Extract<RoomWireMessage, { kind: "ai.job.request" }> | undefined;
    const session = fakeSession(false, playerSeat, {
      sendAiJobRequest: (message) => { sent = message; },
    });
    const coordinator = new RoomAiJobCoordinator({
      session,
      provider: "codex",
      model: "",
    });

    const result = coordinator.requestCharacterDraft("一名谨慎的记者", "Alice");
    expect(sent?.input).toEqual({ prompt: "一名谨慎的记者", playerName: "Alice" });
    coordinator.handleWireMessage(hostSeat, {
      kind: "ai.job.status",
      jobId: sent!.jobId,
      status: "completed",
      message: "done",
      result: { character: character(playerSeat.seatId, "Alice") },
    });
    await expect(result).resolves.toMatchObject({ ownerPeerId: playerSeat.seatId, name: "调查员" });
    coordinator.shutdown();
  });

  it("uses host provider settings and overwrites provider-controlled identity", async () => {
    let executed: CharacterDraftExecutionRequest | undefined;
    const executor: RoomAiDraftExecutor = {
      executeCharacterDraft: vi.fn(async (request) => {
        executed = request;
        return character("seat-attacker-0001", "attacker");
      }),
    };
    const session = fakeSession(true, hostSeat);
    const coordinator = new RoomAiJobCoordinator({
      session,
      executor,
      provider: "deepseek",
      model: "deepseek-chat",
    });
    const statuses: Array<Extract<RoomWireMessage, { kind: "ai.job.status" }>> = [];
    (session.sendAiJobStatusToSeat as ReturnType<typeof vi.fn>).mockImplementation((_seatId, value) => {
      statuses.push(value);
      return true;
    });

    coordinator.handleWireMessage(playerSeat, {
      kind: "ai.job.request",
      jobId: "00000000-0000-4000-8000-000000000011",
      task: "character-draft",
      provider: "codex",
      model: "ignore-player-model",
      input: {
        prompt: "一名医生",
        playerName: "Alice",
        path: "C:/secret",
        command: "shell",
      },
    });
    await vi.waitFor(() => expect(statuses.at(-1)?.status).toBe("completed"));

    expect(executed).toMatchObject({
      provider: "deepseek",
      model: "deepseek-chat",
      prompt: "一名医生",
      playerName: "Alice",
      ownerSeatId: playerSeat.seatId,
    });
    const completed = statuses.at(-1)!;
    expect((completed.result as { character: Coc7Character }).character.ownerPeerId).toBe(playerSeat.seatId);
    expect(JSON.stringify(executed)).not.toContain("C:/secret");
    coordinator.shutdown();
  });

  it("rejects remote NPC/provider proxy jobs without executing them", async () => {
    const executeCharacterDraft = vi.fn();
    const session = fakeSession(true, hostSeat);
    const statuses: Array<Extract<RoomWireMessage, { kind: "ai.job.status" }>> = [];
    (session.sendAiJobStatusToSeat as ReturnType<typeof vi.fn>).mockImplementation((_seatId, value) => {
      statuses.push(value);
      return true;
    });
    const coordinator = new RoomAiJobCoordinator({
      session,
      executor: { executeCharacterDraft },
      provider: "codex",
      model: "",
    });
    coordinator.handleWireMessage(playerSeat, {
      kind: "ai.job.request",
      jobId: "00000000-0000-4000-8000-000000000012",
      task: "npc-dialogue",
      provider: "codex",
      model: "",
      input: { prompt: "read the whole module" },
    });
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ status: "failed" });
    expect(executeCharacterDraft).not.toHaveBeenCalled();
    coordinator.shutdown();
  });

  it("rejects descriptions over 8,000 Unicode code points before transport", async () => {
    const session = fakeSession(false, playerSeat);
    const coordinator = new RoomAiJobCoordinator({ session, provider: "codex", model: "" });
    await expect(coordinator.requestCharacterDraft("蝶".repeat(8_001), "Alice"))
      .rejects.toThrow("8000");
    expect(session.sendAiJobRequest).not.toHaveBeenCalled();
    coordinator.shutdown();
  });
});

function fakeSession(
  isHost: boolean,
  localSeat: SeatV2,
  overrides: Partial<RoomSessionV2> = {},
): RoomSessionV2 {
  return {
    isHost,
    localSeat,
    sendAiJobRequest: vi.fn(),
    sendAiJobStatusToSeat: vi.fn(() => true),
    ...overrides,
  } as unknown as RoomSessionV2;
}

function character(ownerPeerId: string, playerName: string): Coc7Character {
  return {
    schemaVersion: 1,
    id: "character-draft-0001",
    ownerPeerId,
    name: "调查员",
    playerName,
    occupation: "记者",
    age: 28,
    residence: "东京",
    birthplace: "横滨",
    characteristics: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 60, pow: 50, edu: 60, luck: 50 },
    derived: {
      hitPoints: 10,
      maxHitPoints: 10,
      magicPoints: 10,
      maxMagicPoints: 10,
      sanity: 50,
      maxSanity: 99,
      movementRate: 8,
      build: 0,
      damageBonus: "0",
    },
    skills: [],
    status: { temporaryInsanity: false, indefiniteInsanity: false, majorWound: false, dying: false, unconscious: false },
    inventory: [],
    background: {
      personalDescription: "",
      ideologyAndBeliefs: "",
      significantPeople: "",
      meaningfulLocations: "",
      treasuredPossessions: "",
      traits: "",
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

