// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalRepository, RoomRecord } from "./data/repository";
import { useAppStore } from "./store/app-store";

const mocks = vi.hoisted(() => ({
  getRepository: vi.fn(),
  connect: undefined as undefined | ((room: RoomRecord, nickname: string) => Promise<void>),
  sessionStart: vi.fn(),
  sessionStop: vi.fn(),
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
vi.mock("./views/CharactersView", () => ({ CharactersView: () => <div>角色</div> }));
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
  RoomSessionV2: class MockRoomSessionV2 {
    readonly isHost = false;
    readonly localSeat = { seatId: "seat-player", role: "player", displayName: "player", extensions: {} };
    private readonly roomId: string;

    constructor({ room }: { room: RoomRecord }) {
      this.roomId = room.id;
    }

    start() {
      return mocks.sessionStart(this.roomId);
    }

    stop() {
      mocks.sessionStop(this.roomId);
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
    shutdown() {}
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
