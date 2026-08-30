import { afterEach, describe, expect, it, vi } from "vitest";
import type { Coc7Character, SeatV2 } from "@coc-room/protocol";
import type { RoomSessionV2 } from "../network/RoomSessionV2";
import type { RoomWireMessage } from "../network/RoomTransport";
import {
  RoomAiJobCoordinator,
  type CharacterDraftExecutionRequest,
  type RoomAiDraftExecutor,
} from "./room-ai-job-coordinator";

type AiJobRequest = Extract<RoomWireMessage, { kind: "ai.job.request" }>;
type AiJobStatus = Extract<RoomWireMessage, { kind: "ai.job.status" }>;

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

afterEach(() => {
  vi.useRealTimers();
});

describe("RoomAiJobCoordinator", () => {
  it("keeps a player result transient and resolves only after a host status", async () => {
    let sent: AiJobRequest | undefined;
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
    const statuses: AiJobStatus[] = [];
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
    expect(statuses.at(-1)?.message).toContain("等待 KP 同意");
    coordinator.approveRequest("00000000-0000-4000-8000-000000000011");
    await vi.waitFor(() => expect(statuses.at(-1)?.status).toBe("completed"));

    expect(executed).toMatchObject({
      provider: "deepseek",
      model: "deepseek-chat",
      prompt: "一名医生",
      playerName: "Alice",
      ownerSeatId: playerSeat.seatId,
    });
    const completed = statuses.at(-1)!;
    expect(completed.status).toBe("completed");
    expect((completed.result as { character: Coc7Character }).character.ownerPeerId).toBe(playerSeat.seatId);
    expect(JSON.stringify(executed)).not.toContain("C:/secret");
    coordinator.shutdown();
  });

  it("rejects remote NPC/provider proxy jobs without executing them", async () => {
    const executeCharacterDraft = vi.fn();
    const session = fakeSession(true, hostSeat);
    const statuses: AiJobStatus[] = [];
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

  it("rejects descriptions over 100,000 Unicode code points before transport", async () => {
    const session = fakeSession(false, playerSeat);
    const coordinator = new RoomAiJobCoordinator({ session, provider: "codex", model: "" });
    await expect(coordinator.requestCharacterDraft("蝶".repeat(100_001), "Alice"))
      .rejects.toThrow("100000");
    expect(session.sendAiJobRequest).not.toHaveBeenCalled();

    const atLimit = coordinator.requestCharacterDraft("蝶".repeat(100_000), "Alice");
    expect(session.sendAiJobRequest).toHaveBeenCalledTimes(1);
    coordinator.shutdown();
    await expect(atLimit).rejects.toThrow("房间 AI 草稿代理已经关闭");
  });

  it("holds a remote request for KP approval and spends no host AI before consent", async () => {
    const session = fakeSession(true, hostSeat);
    const statuses: AiJobStatus[] = [];
    (session.sendAiJobStatusToSeat as ReturnType<typeof vi.fn>).mockImplementation((_seatId, value) => {
      statuses.push(value);
      return true;
    });
    const executeCharacterDraft = vi.fn(async () => character(playerSeat.seatId, "Alice"));
    const reviews: Array<{ seat: SeatV2; status: AiJobStatus }> = [];
    const coordinator = new RoomAiJobCoordinator({
      session,
      executor: { executeCharacterDraft },
      provider: "codex",
      model: "",
      onHostStatus: (seat, status) => { reviews.push({ seat, status }); },
    });

    coordinator.handleWireMessage(playerSeat, draftRequest("00000000-0000-4000-8000-000000000021"));

    // Nothing runs and nothing completes until the KP consents.
    expect(executeCharacterDraft).not.toHaveBeenCalled();
    expect(statuses.map(({ status }) => status)).not.toContain("completed");
    const notice = statuses.at(-1)!;
    expect(notice.status).toBe("queued");
    expect(notice.message).toContain("等待 KP 同意");
    expect((notice.result as { pendingApproval?: boolean }).pendingApproval).toBe(true);
    const review = reviews.at(-1)!;
    expect(review.seat.seatId).toBe(playerSeat.seatId);
    expect(review.status.result).toMatchObject({ approvalRequest: true, prompt: "一名医生", playerName: "Alice" });
    coordinator.shutdown();
  });

  it("approves a request end to end so the player promise resolves with the character", async () => {
    const bridge = bridgedCoordinators();

    const result = bridge.player.requestCharacterDraft("一名医生", "Alice");
    await vi.waitFor(() => expect(bridge.playerStages.at(-1)).toContain("等待 KP 同意"));
    expect(bridge.reviewJobIds).toHaveLength(1);

    expect(bridge.host.approveRequest(bridge.reviewJobIds[0]!)).toBe(true);
    await expect(result).resolves.toMatchObject({ ownerPeerId: playerSeat.seatId, playerName: "Alice" });
    bridge.shutdown();
  });

  it("returns a rejected request to the player with the KP's reason", async () => {
    const bridge = bridgedCoordinators();

    const result = bridge.player.requestCharacterDraft("一名医生", "Alice");
    await vi.waitFor(() => expect(bridge.reviewJobIds).toHaveLength(1));

    expect(bridge.host.rejectRequest(bridge.reviewJobIds[0]!, "职业与本团年代不符")).toBe(true);
    await expect(result).rejects.toThrow("KP 拒绝了这次 AI 车卡申请：职业与本团年代不符");
    bridge.shutdown();
  });

  it("parks undeliverable statuses in an outbox and flushes them on demand", async () => {
    const session = fakeSession(true, hostSeat);
    const sendMock = session.sendAiJobStatusToSeat as ReturnType<typeof vi.fn>;
    sendMock.mockImplementation(() => false);
    const reviews: AiJobStatus[] = [];
    const coordinator = new RoomAiJobCoordinator({
      session,
      executor: { executeCharacterDraft: async () => character(playerSeat.seatId, "Alice") },
      provider: "codex",
      model: "",
      onHostStatus: (_seat, status) => { reviews.push(status); },
    });

    coordinator.handleWireMessage(playerSeat, draftRequest("00000000-0000-4000-8000-000000000031"));

    const delivered: AiJobStatus[] = [];
    sendMock.mockImplementation((_seatId, value) => {
      delivered.push(value);
      return true;
    });
    coordinator.flushOutbox(playerSeat.seatId);
    // Only the latest status per job survives in the outbox.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.message).toContain("等待 KP 同意");

    sendMock.mockImplementation(() => false);
    coordinator.approveRequest("00000000-0000-4000-8000-000000000031");
    await vi.waitFor(() => expect(reviews.at(-1)?.status).toBe("completed"));
    sendMock.mockImplementation((_seatId, value) => {
      delivered.push(value);
      return true;
    });
    coordinator.flushOutbox();
    expect(delivered.at(-1)).toMatchObject({ status: "completed" });
    coordinator.shutdown();
  });

  it("re-delivers the current state when a duplicate request arrives, but only to the owning seat", async () => {
    const session = fakeSession(true, hostSeat);
    const sent: Array<{ seatId: string; status: AiJobStatus }> = [];
    (session.sendAiJobStatusToSeat as ReturnType<typeof vi.fn>).mockImplementation((seatId, value) => {
      sent.push({ seatId, status: value });
      return true;
    });
    const reviews: AiJobStatus[] = [];
    const coordinator = new RoomAiJobCoordinator({
      session,
      executor: { executeCharacterDraft: async () => character(playerSeat.seatId, "Alice") },
      provider: "codex",
      model: "",
      onHostStatus: (_seat, status) => { reviews.push(status); },
    });
    const jobId = "00000000-0000-4000-8000-000000000041";

    coordinator.handleWireMessage(playerSeat, draftRequest(jobId));
    const sentBeforeReplay = sent.length;

    // While awaiting approval: the replay gets the waiting notice again.
    coordinator.handleWireMessage(playerSeat, draftRequest(jobId));
    expect(sent).toHaveLength(sentBeforeReplay + 1);
    expect(sent.at(-1)!.status.message).toContain("等待 KP 同意");
    // The replay must not create a second approval row.
    expect(reviews.filter((review) => (review.result as { approvalRequest?: boolean } | undefined)?.approvalRequest)).toHaveLength(1);

    // A different seat replaying the same jobId gets nothing.
    const rival: SeatV2 = { seatId: "seat-player-0002", role: "player", displayName: "Mallory", extensions: {} };
    coordinator.handleWireMessage(rival, draftRequest(jobId));
    expect(sent).toHaveLength(sentBeforeReplay + 1);

    // After approval the terminal result is re-sent on replay.
    coordinator.approveRequest(jobId);
    await vi.waitFor(() => expect(reviews.at(-1)?.status).toBe("completed"));
    coordinator.handleWireMessage(playerSeat, draftRequest(jobId));
    expect(sent.at(-1)!.status).toMatchObject({ status: "completed" });
    expect(sent.at(-1)!.seatId).toBe(playerSeat.seatId);
    coordinator.shutdown();
  });

  it("does not surface the host's own drafts in the KP review list", async () => {
    const onHostStatus = vi.fn();
    const session = fakeSession(true, hostSeat);
    const coordinator = new RoomAiJobCoordinator({
      session,
      executor: { executeCharacterDraft: async () => character(hostSeat.seatId, "KP") },
      provider: "codex",
      model: "",
      onHostStatus,
    });

    await expect(coordinator.requestCharacterDraft("KP 自己的调查员", "KP"))
      .resolves.toMatchObject({ ownerPeerId: hostSeat.seatId });
    expect(onHostStatus).not.toHaveBeenCalled();
    coordinator.shutdown();
  });

  it("refreshes the client timer on non-terminal statuses and reports an honest review timeout", async () => {
    vi.useFakeTimers();
    let sent: AiJobRequest | undefined;
    const stages: string[] = [];
    const session = fakeSession(false, playerSeat, {
      sendAiJobRequest: (message) => { sent = message; },
    });
    const coordinator = new RoomAiJobCoordinator({
      session,
      provider: "codex",
      model: "",
      timeoutMs: 1_000,
      onClientStatus: (status) => { stages.push(status.message); },
    });

    const result = coordinator.requestCharacterDraft("一名谨慎的记者", "Alice");
    let settled: Error | undefined;
    result.catch((error: Error) => { settled = error; });

    // The base window is timeoutMs + 5s = 6s; the notice at t=5s re-arms it.
    vi.advanceTimersByTime(5_000);
    coordinator.handleWireMessage(hostSeat, {
      kind: "ai.job.status",
      jobId: sent!.jobId,
      status: "queued",
      message: "已发送申请，等待 KP 同意用房主的 AI 生成",
      result: { pendingApproval: true },
    });
    expect(stages).toEqual(["已发送申请，等待 KP 同意用房主的 AI 生成"]);
    vi.advanceTimersByTime(5_999);
    await Promise.resolve();
    expect(settled).toBeUndefined();

    vi.advanceTimersByTime(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled?.message).toBe("KP 尚未同意这次 AI 车卡申请；可以稍后重新申请，或当面和 KP 说一声");
    coordinator.shutdown();
  });

  it("keeps the generic timeout message when the host never responded at all", async () => {
    vi.useFakeTimers();
    const session = fakeSession(false, playerSeat);
    const coordinator = new RoomAiJobCoordinator({ session, provider: "codex", model: "", timeoutMs: 1_000 });
    const result = coordinator.requestCharacterDraft("一名谨慎的记者", "Alice");
    const rejection = expect(result).rejects.toThrow("角色草稿请求超时");
    vi.advanceTimersByTime(6_001);
    await rejection;
    coordinator.shutdown();
  });

  it("re-sends unfinished requests after the player re-authenticates", async () => {
    const requests: AiJobRequest[] = [];
    const session = fakeSession(false, playerSeat, {
      sendAiJobRequest: (message) => { requests.push(message); },
    });
    const coordinator = new RoomAiJobCoordinator({ session, provider: "codex", model: "" });

    const result = coordinator.requestCharacterDraft("一名谨慎的记者", "Alice");
    expect(requests).toHaveLength(1);
    coordinator.resendPendingRequests();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);

    coordinator.shutdown();
    await expect(result).rejects.toThrow("房间 AI 草稿代理已经关闭");
    coordinator.resendPendingRequests();
    expect(requests).toHaveLength(2);
  });
});

function bridgedCoordinators() {
  const reviewJobIds: string[] = [];
  const playerStages: string[] = [];
  let player: RoomAiJobCoordinator;
  const hostSession = fakeSession(true, hostSeat, {
    sendAiJobStatusToSeat: vi.fn((_seatId: string, message: AiJobStatus) => {
      player.handleWireMessage(hostSeat, message);
      return true;
    }) as RoomSessionV2["sendAiJobStatusToSeat"],
  });
  const host = new RoomAiJobCoordinator({
    session: hostSession,
    executor: { executeCharacterDraft: async () => character(playerSeat.seatId, "Alice") },
    provider: "codex",
    model: "",
    onHostStatus: (_seat, status) => {
      if ((status.result as { approvalRequest?: boolean } | undefined)?.approvalRequest) reviewJobIds.push(status.jobId);
    },
  });
  const playerSession = fakeSession(false, playerSeat, {
    sendAiJobRequest: (message) => { host.handleWireMessage(playerSeat, message); },
  });
  player = new RoomAiJobCoordinator({
    session: playerSession,
    provider: "codex",
    model: "",
    onClientStatus: (status) => { playerStages.push(status.message); },
  });
  return {
    host,
    player,
    reviewJobIds,
    playerStages,
    shutdown: () => {
      player.shutdown();
      host.shutdown();
    },
  };
}

function draftRequest(jobId: string): AiJobRequest {
  return {
    kind: "ai.job.request",
    jobId,
    task: "character-draft",
    provider: "codex",
    model: "",
    input: { prompt: "一名医生", playerName: "Alice" },
  };
}

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
