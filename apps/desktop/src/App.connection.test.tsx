// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Coc7Character, SeatV2 } from "@coc-room/protocol";
import type { LocalRepository, RoomRecord } from "./data/repository";
import { useAppStore } from "./store/app-store";

interface MockSessionV2Handle {
  onPresence?: (seats: SeatV2[]) => void;
  onAuthenticationState?: (state: "waiting" | "challenged" | "authenticated" | "failed") => void;
  onRelayStateChange?: (connected: boolean) => void;
  onError?: (message: string) => void;
}

interface MockAiCoordinatorOptions {
  onClientStatus?: (status: { jobId: string; status: string; message: string; result?: unknown }) => void;
}

const mocks = vi.hoisted(() => ({
  getRepository: vi.fn(),
  connect: undefined as undefined | ((room: RoomRecord, nickname: string) => Promise<void>),
  sessionStart: vi.fn(),
  sessionStop: vi.fn(),
  lastSessionV2: undefined as undefined | MockSessionV2Handle,
  lastAiOptions: undefined as undefined | MockAiCoordinatorOptions,
  audioRuntimes: [] as Array<{
    dispose: ReturnType<typeof vi.fn>;
    setLocalVolume: ReturnType<typeof vi.fn>;
    setMuted: ReturnType<typeof vi.fn>;
    consumeView: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("./data/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./data/repository")>();
  return { ...actual, getRepository: mocks.getRepository };
});

vi.mock("./views/LobbyView", () => ({
  LobbyView: ({ onConnect }: { onConnect(room: RoomRecord, nickname: string): Promise<void> }) => {
    mocks.connect = onConnect;
    return <div>连接测试大厅</div>;
  },
}));

vi.mock("./views/RoomView", () => ({ RoomView: () => <div>旧版房间</div> }));
vi.mock("./views/RoomViewV2", () => ({
  RoomViewV2: ({ room, onLeave }: { room: RoomRecord; onLeave(): void }) => (
    <div>
      当前房间：{room.name}
      <button type="button" onClick={onLeave}>离开当前房间</button>
    </div>
  ),
}));
vi.mock("./views/CharactersView", () => ({
  CharactersView: ({ lateApprovedDraft }: { lateApprovedDraft?: unknown }) => (
    <div>{lateApprovedDraft ? "存在迟到批准草稿" : "没有迟到批准草稿"}</div>
  ),
}));
vi.mock("./views/ModulesView", () => ({ ModulesView: () => <div>模组</div> }));
vi.mock("./views/SettingsView", () => ({ SettingsView: () => <div>设置</div> }));

vi.mock("./network/RoomSession", () => ({
  RoomSession: class MockRoomSession {
    constructor() {
      throw new Error("unexpected legacy session");
    }
  },
}));

vi.mock("./network/RoomSessionV2", () => ({
  RoomSessionV2: class MockRoomSessionV2 implements MockSessionV2Handle {
    readonly isHost = false;
    readonly localSeat = { seatId: "seat-player", role: "player", displayName: "player", extensions: {} };
    onPresence?: MockSessionV2Handle["onPresence"];
    onAuthenticationState?: MockSessionV2Handle["onAuthenticationState"];
    onRelayStateChange?: MockSessionV2Handle["onRelayStateChange"];
    onError?: MockSessionV2Handle["onError"];
    private readonly roomId: string;

    constructor({ room }: { room: RoomRecord }) {
      this.roomId = room.id;
      mocks.lastSessionV2 = this;
    }

    start() {
      return mocks.sessionStart(this.roomId);
    }

    stop() {
      mocks.sessionStop(this.roomId);
    }
  },
}));

vi.mock("./lib/audio-sync", () => ({
  SynchronizedAudioRuntime: class MockSynchronizedAudioRuntime {
    dispose = vi.fn();
    setLocalVolume = vi.fn();
    setMuted = vi.fn();
    consumeView = vi.fn();

    constructor() {
      mocks.audioRuntimes.push(this);
    }
  },
}));

vi.mock("./network/RoomAssetCoordinator", () => ({
  RoomAssetCoordinator: class MockRoomAssetCoordinator {
    dispose() {}
    async resolve() { return "blob:test"; }
  },
}));

vi.mock("./ai/room-ai-job-coordinator", () => ({
  RoomAiJobCoordinator: class MockRoomAiJobCoordinator {
    constructor(options: MockAiCoordinatorOptions) {
      mocks.lastAiOptions = options;
    }

    shutdown() {}
    flushOutbox() {}
    resendPendingRequests() {}
    approveRequest() { return false; }
    rejectRequest() { return false; }
    async requestCharacterDraft() { throw new Error("not used"); }
  },
}));

import { App } from "./App";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function room(id: string, name: string): RoomRecord {
  return {
    id,
    name,
    localRole: "player",
    localPeerId: `${id}-peer`,
    hostPeerId: `${id}-host`,
    inviteToken: `${id}-host.${"s".repeat(43)}`,
    relayUrl: `ws://127.0.0.1:8787/v1/rooms/${id}/ws`,
    lastSeq: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    protocolVersion: 2,
    localSeatId: `${id}-seat`,
    hostSeatId: `${id}-host-seat`,
    seatCredentialVersion: 1,
  };
}

function repository(rooms: RoomRecord[]): LocalRepository {
  return {
    listRooms: vi.fn(async () => rooms),
    listModules: vi.fn(async () => []),
    getSetting: vi.fn(async () => undefined),
  } as unknown as LocalRepository;
}

beforeEach(() => {
  mocks.connect = undefined;
  mocks.sessionStart.mockReset();
  mocks.sessionStop.mockReset();
  mocks.lastSessionV2 = undefined;
  mocks.lastAiOptions = undefined;
  mocks.audioRuntimes.length = 0;
  useAppStore.setState({
    activeView: "lobby",
    currentRoom: undefined,
    rooms: [],
    modules: [],
    events: [],
    participants: [],
    paths: {},
    relayConnected: false,
    connectionPhase: "idle",
    connectionError: undefined,
  });
});

afterEach(() => {
  cleanup();
  mocks.getRepository.mockReset();
  useAppStore.getState().leaveRoom();
});

describe("App connection attempt ownership", () => {
  it("stops a pending predecessor and ignores its late completion", async () => {
    const firstRoom = room("room-first", "第一间房");
    const secondRoom = room("room-second", "第二间房");
    const firstStart = deferred<void>();
    const secondStart = deferred<void>();
    mocks.getRepository.mockResolvedValue(repository([firstRoom, secondRoom]));
    mocks.sessionStart.mockImplementation((roomId: string) => roomId === firstRoom.id ? firstStart.promise : secondStart.promise);

    render(<App />);
    await screen.findByText("连接测试大厅");
    if (!mocks.connect) throw new Error("missing App connect callback");

    let firstPromise!: Promise<void>;
    act(() => {
      firstPromise = mocks.connect!(firstRoom, "玩家一");
    });
    const firstOutcome = firstPromise.then(() => undefined, (error: unknown) => error);
    await waitFor(() => expect(mocks.sessionStart).toHaveBeenCalledWith(firstRoom.id));

    let secondPromise!: Promise<void>;
    act(() => {
      secondPromise = mocks.connect!(secondRoom, "玩家二");
    });
    await waitFor(() => expect(mocks.sessionStart).toHaveBeenCalledWith(secondRoom.id));
    expect(mocks.sessionStop).toHaveBeenCalledWith(firstRoom.id);

    await act(async () => {
      secondStart.resolve(undefined);
      await secondPromise;
    });
    expect(useAppStore.getState().currentRoom?.id).toBe(secondRoom.id);
    expect(useAppStore.getState().connectionPhase).toBe("live");
    expect(screen.getByText(`当前房间：${secondRoom.name}`)).toBeTruthy();

    let staleResult: unknown;
    await act(async () => {
      firstStart.resolve(undefined);
      staleResult = await firstOutcome;
    });
    expect(staleResult).toMatchObject({ name: "AbortError" });
    expect(useAppStore.getState().currentRoom?.id).toBe(secondRoom.id);
    expect(useAppStore.getState().connectionPhase).toBe("live");
    expect(useAppStore.getState().connectionError).toBeUndefined();
    expect(mocks.sessionStop).not.toHaveBeenCalledWith(secondRoom.id);

    fireEvent.click(screen.getByRole("button", { name: "离开当前房间" }));
    expect(mocks.sessionStop).toHaveBeenCalledWith(secondRoom.id);
    expect(useAppStore.getState().currentRoom).toBeUndefined();
    expect(useAppStore.getState().connectionPhase).toBe("idle");
    expect(useAppStore.getState().connectionError).toBeUndefined();
  });
});

async function connectLive(target: RoomRecord, nickname = "玩家"): Promise<void> {
  if (!mocks.connect) throw new Error("missing App connect callback");
  let pending!: Promise<void>;
  act(() => {
    pending = mocks.connect!(target, nickname);
  });
  await act(async () => {
    await pending;
  });
  expect(useAppStore.getState().connectionPhase).toBe("live");
}

function approvedDraftCharacter(): Coc7Character {
  return {
    schemaVersion: 1,
    id: "character-late-approved",
    ownerPeerId: "seat-player",
    name: "迟到的调查员",
    playerName: "玩家",
    occupation: "档案管理员",
    age: 32,
    residence: "阿卡姆",
    birthplace: "波士顿",
    characteristics: { str: 45, con: 55, siz: 50, dex: 60, app: 55, int: 70, pow: 60, edu: 65, luck: 50 },
    derived: { hitPoints: 10, maxHitPoints: 10, magicPoints: 12, maxMagicPoints: 12, sanity: 60, maxSanity: 99, movementRate: 8, build: 0, damageBonus: "0" },
    skills: [{ id: "skill-library-use", name: "图书馆使用", baseValue: 20, value: 70, checked: false }],
    status: { temporaryInsanity: false, indefiniteInsanity: false, majorWound: false, dying: false, unconscious: false },
    inventory: [],
    background: { personalDescription: "", ideologyAndBeliefs: "", significantPeople: "", meaningfulLocations: "", treasuredPossessions: "", traits: "", injuriesAndScars: "", phobiasAndManias: "", arcaneTomesSpellsAndArtifacts: "", encountersWithStrangeEntities: "" },
    notes: "",
    updatedAt: "2026-08-29T00:00:00.000Z",
    extensions: {},
  };
}

describe("App V2 room presentation", () => {
  it("keeps the ambience audio runtime alive across main-nav switches and disposes it on leave", async () => {
    const testRoom = room("room-audio", "音频之房");
    mocks.getRepository.mockResolvedValue(repository([testRoom]));
    render(<App />);
    await screen.findByText("连接测试大厅");

    await connectLive(testRoom);
    await waitFor(() => expect(mocks.audioRuntimes).toHaveLength(1));
    const runtime = mocks.audioRuntimes[0]!;
    expect(runtime.setLocalVolume).toHaveBeenCalledWith(1);
    expect(runtime.dispose).not.toHaveBeenCalled();

    // Browsing another main tab unmounts the room view; the table's music
    // must keep playing through it.
    fireEvent.click(screen.getAllByRole("button", { name: "我的调查员" })[0]!);
    expect(await screen.findByText("没有迟到批准草稿")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(`当前房间：${testRoom.name}`)).toBeNull());
    expect(runtime.dispose).not.toHaveBeenCalled();
    expect(mocks.audioRuntimes).toHaveLength(1);

    fireEvent.click(screen.getAllByRole("button", { name: "调查现场" })[0]!);
    expect(await screen.findByText(`当前房间：${testRoom.name}`)).toBeTruthy();
    expect(mocks.audioRuntimes).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "离开当前房间" }));
    await waitFor(() => expect(runtime.dispose).toHaveBeenCalled());
  });

  it("drops a late-approved AI draft when the player switches rooms", async () => {
    const firstRoom = room("room-draft-a", "甲团");
    const secondRoom = room("room-draft-b", "乙团");
    mocks.getRepository.mockResolvedValue(repository([firstRoom, secondRoom]));
    render(<App />);
    await screen.findByText("连接测试大厅");

    await connectLive(firstRoom, "玩家一");
    act(() => {
      mocks.lastAiOptions?.onClientStatus?.({
        jobId: "job-late-approved",
        status: "completed",
        message: "KP 已通过草稿",
        result: { character: approvedDraftCharacter() },
      });
    });
    fireEvent.click(screen.getAllByRole("button", { name: "我的调查员" })[0]!);
    expect(await screen.findByText("存在迟到批准草稿")).toBeTruthy();

    await connectLive(secondRoom, "玩家一");
    fireEvent.click(screen.getAllByRole("button", { name: "我的调查员" })[0]!);
    expect(await screen.findByText("没有迟到批准草稿")).toBeTruthy();
    expect(screen.queryByText("存在迟到批准草稿")).toBeNull();
  });

  it("shows the paused room to a player who joins while the host is absent", async () => {
    const testRoom = room("room-absent-host", "无主之房");
    mocks.getRepository.mockResolvedValue(repository([testRoom]));
    render(<App />);
    await screen.findByText("连接测试大厅");

    await connectLive(testRoom);
    const session = mocks.lastSessionV2;
    if (!session) throw new Error("missing mock session");
    act(() => {
      session.onRelayStateChange?.(true);
      session.onPresence?.([
        { seatId: testRoom.localSeatId!, role: "player", displayName: "玩家", extensions: {} },
      ]);
    });
    expect(screen.getByText("房主离线 · 房间暂停")).toBeTruthy();

    act(() => {
      session.onPresence?.([
        { seatId: testRoom.hostSeatId!, role: "host", displayName: "KP", peerId: testRoom.hostPeerId, extensions: {} },
        { seatId: testRoom.localSeatId!, role: "player", displayName: "玩家", extensions: {} },
      ]);
    });
    expect(screen.queryByText("房主离线 · 房间暂停")).toBeNull();
    expect(screen.getByText("房间已连接")).toBeTruthy();
  });

  it("clears the V2 connection error once the relay reconnects", async () => {
    const testRoom = room("room-relay-blip", "中继闪断");
    mocks.getRepository.mockResolvedValue(repository([testRoom]));
    render(<App />);
    await screen.findByText("连接测试大厅");

    await connectLive(testRoom);
    const session = mocks.lastSessionV2;
    if (!session) throw new Error("missing mock session");
    act(() => {
      session.onRelayStateChange?.(false);
      session.onError?.("中继节点连接已断开；现有直连可继续，正在尝试重连");
    });
    expect(useAppStore.getState().connectionError).toContain("中继节点连接已断开");

    act(() => {
      session.onRelayStateChange?.(true);
    });
    expect(useAppStore.getState().connectionError).toBeUndefined();
    expect(useAppStore.getState().relayConnected).toBe(true);
  });

  it("labels a seat authentication failure instead of claiming the host is offline", async () => {
    const testRoom = room("room-auth-failed", "认证失败之房");
    mocks.getRepository.mockResolvedValue(repository([testRoom]));
    render(<App />);
    await screen.findByText("连接测试大厅");

    await connectLive(testRoom);
    const session = mocks.lastSessionV2;
    if (!session) throw new Error("missing mock session");
    act(() => {
      session.onRelayStateChange?.(true);
      session.onAuthenticationState?.("failed");
    });
    expect(screen.getByText("席位验证失败：邀请可能已被换新，请向 KP 索取新邀请串")).toBeTruthy();
    expect(screen.queryByText("房主离线 · 房间暂停")).toBeNull();
  });
});
