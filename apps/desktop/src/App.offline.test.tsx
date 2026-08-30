// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeInvitationV2 } from "./lib/invitation";
import type { LocalRepository, RoomRecord } from "./data/repository";
import type { RoomEventV1 } from "@coc-room/protocol";
import { useAppStore } from "./store/app-store";

const mocks = vi.hoisted(() => ({
  getRepository: vi.fn(),
  roomSessionConstructor: vi.fn(),
  roomSessionStart: vi.fn(),
  roomSessionStop: vi.fn(),
}));

vi.mock("./data/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./data/repository")>();
  return { ...actual, getRepository: mocks.getRepository };
});

vi.mock("./network/RoomSession", () => ({
  RoomSession: class MockRoomSession {
    private readonly roomId: string;

    constructor(options: { room: RoomRecord }) {
      this.roomId = options.room.id;
      mocks.roomSessionConstructor(options);
    }

    start() {
      return mocks.roomSessionStart(this.roomId);
    }

    stop() {
      mocks.roomSessionStop(this.roomId);
    }
  },
}));

vi.mock("./network/RoomSessionV2", () => ({
  RoomSessionV2: class MockRoomSessionV2 {
    readonly isHost = false;
    readonly localSeat = { seatId: "seat-player", role: "player", displayName: "player", extensions: {} };
    private readonly roomId: string;

    constructor(options: { room: RoomRecord }) {
      this.roomId = options.room.id;
      mocks.roomSessionConstructor(options);
    }

    start() {
      return mocks.roomSessionStart(this.roomId);
    }

    stop() {
      mocks.roomSessionStop(this.roomId);
    }
  },
}));

vi.mock("./views/RoomViewV2", () => ({
  RoomViewV2: ({ room: activeRoom }: { room: RoomRecord }) => <div>已进入 {activeRoom.name}</div>,
}));

import { App } from "./App";

const room: RoomRecord = {
  id: "archived-room",
  name: "离线调查",
  localRole: "player",
  localPeerId: "local-peer",
  hostPeerId: "host-peer",
  inviteToken: "saved-token",
  relayUrl: "wss://relay.invalid/v1/rooms/archived-room/ws",
  lastSeq: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const connectedRoom = (id: string, name: string): RoomRecord => ({
  id,
  name,
  localRole: "player",
  localPeerId: `${id}-peer`,
  hostPeerId: `${id}-host`,
  inviteToken: `${id}-host.${"s".repeat(43)}`,
  relayUrl: `ws://127.0.0.1:8787/v1/rooms/${id}/ws`,
  lastSeq: 0,
  createdAt: "2026-01-03T00:00:00.000Z",
  updatedAt: "2026-01-03T00:00:00.000Z",
  protocolVersion: 2,
  localSeatId: `${id}-seat`,
  hostSeatId: `${id}-host-seat`,
  seatCredentialVersion: 1,
});

const savedEvent: RoomEventV1 = {
  protocolVersion: 1,
  roomId: room.id,
  eventId: "00000000-0000-4000-8000-000000000001",
  sequence: 1,
  sender: { peerId: "host-peer", displayName: "守秘人", role: "host" },
  type: "system.notice",
  occurredAt: "2026-01-01T00:10:00.000Z",
  payload: { message: "这是本机保存的记录。", level: "info" },
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createRepository(rooms: RoomRecord[] = [room]): LocalRepository {
  return {
    listRooms: vi.fn(async () => rooms),
    listModules: vi.fn(async () => []),
    listEvents: vi.fn(async () => [savedEvent]),
    listEventViewsV2: vi.fn(async () => []),
    getSetting: vi.fn(async () => undefined),
  } as unknown as LocalRepository;
}

beforeEach(() => {
  const repository = createRepository();
  mocks.getRepository.mockResolvedValue(repository);
  mocks.roomSessionConstructor.mockClear();
  mocks.roomSessionStart.mockReset().mockResolvedValue(undefined);
  mocks.roomSessionStop.mockClear();
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
  vi.unstubAllGlobals();
  mocks.getRepository.mockReset();
  useAppStore.getState().leaveRoom();
});

describe("App startup hydration", () => {
  it("keeps the lobby unavailable until rooms and saved settings are loaded", async () => {
    const loading = deferred<LocalRepository>();
    const repository = createRepository([]);
    vi.mocked(repository.getSetting).mockImplementation(async (key) => key === "relayUrl" ? "https://relay.saved.example" : undefined);
    mocks.getRepository.mockReturnValue(loading.promise);

    render(<App />);

    expect(screen.getByRole("status").textContent).toContain("正在读取本机保存的房间与设置");
    expect(screen.queryByRole("button", { name: /我是 KP，开一个新团/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /我是玩家，加入朋友/ })).toBeNull();

    loading.resolve(repository);

    expect(await screen.findByRole("heading", { name: "今晚，开始一次调查。" })).toBeTruthy();
    expect(useAppStore.getState().relayUrl).toBe("https://relay.saved.example");
  });

  it("shows a readable failure and retries repository hydration", async () => {
    mocks.getRepository
      .mockRejectedValueOnce(new Error("indexeddb temporarily unavailable"))
      .mockResolvedValueOnce(createRepository([]));

    render(<App />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("暂时打不开本机调查资料");
    expect(screen.queryByRole("button", { name: /我是 KP，开一个新团/ })).toBeNull();
    expect(screen.getByRole("button", { name: "重新加载应用" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));

    expect(await screen.findByRole("heading", { name: "今晚，开始一次调查。" })).toBeTruthy();
    expect(mocks.getRepository).toHaveBeenCalledTimes(2);
  });
});

describe("App local record mode", () => {
  it("loads saved events without constructing a RoomSession", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "查看并导出记录" }));

    expect(await screen.findByText("这是本机保存的记录。")).toBeTruthy();
    expect(screen.getAllByText(/本地记录（只读）/).length).toBeGreaterThan(0);
    expect(mocks.roomSessionConstructor).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "返回大厅" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "今晚，继续调查。" })).toBeTruthy());
    expect(useAppStore.getState().currentRoom).toBeUndefined();
    expect(useAppStore.getState().connectionPhase).toBe("idle");
  });
});

describe("App connection ownership", () => {
  it("locks stale live navigation while a replacement connection is pending", async () => {
    const firstRoom = connectedRoom("first-room", "第一间调查");
    const firstStart = deferred<void>();
    const repository = createRepository([room, firstRoom]);
    mocks.getRepository.mockResolvedValue(repository);
    mocks.roomSessionStart.mockImplementation((roomId: string) => {
      if (roomId === firstRoom.id) return firstStart.promise;
      return Promise.resolve();
    });
    vi.stubGlobal("confirm", vi.fn(() => true));
    useAppStore.setState({
      currentRoom: room,
      activeView: "lobby",
      rooms: [room, firstRoom],
      relayConnected: true,
      connectionPhase: "live",
    });

    render(<App />);

    const firstArticle = (await screen.findByRole("heading", { name: firstRoom.name })).closest("article");
    if (!firstArticle) throw new Error("missing first saved room");
    fireEvent.click(within(firstArticle).getByRole("button", { name: "继续调查" }));

    // The session module is intentionally lazy-loaded. Under the full parallel
    // suite its first transform can exceed Testing Library's 1 s default even
    // though the state transition itself is correct.
    await waitFor(
      () => expect(mocks.roomSessionStart).toHaveBeenCalledWith(firstRoom.id),
      { timeout: 5_000 },
    );
    expect(useAppStore.getState().connectionPhase).toBe("connecting");
    expect(useAppStore.getState().currentRoom).toBeUndefined();
    expect(screen.getByText(/正在建立房间连接/)).toBeTruthy();
    expect(screen.queryByText(/你仍在这个房间里/)).toBeNull();
    expect(screen.queryByText("房间已连接")).toBeNull();
    expect(screen.queryByRole("button", { name: "回到现场" })).toBeNull();
    expect(screen.queryByRole("button", { name: "调查现场" })).toBeNull();

    firstStart.resolve(undefined);
    expect(await screen.findByText(`已进入 ${firstRoom.name}`)).toBeTruthy();
    expect(useAppStore.getState().currentRoom?.id).toBe(firstRoom.id);
    expect(useAppStore.getState().connectionPhase).toBe("live");
  });
});

describe("App failed room replacement", () => {
  it("clears stale active-room state while preserving saved room records", async () => {
    const failedRoom: RoomRecord = {
      id: "joined-room-id-12345",
      name: "雾港来信",
      localRole: "player",
      localPeerId: "failed-player-peer",
      hostPeerId: "host-id-1234",
      inviteToken: "host-id-1234." + "s".repeat(43),
      relayUrl: "ws://127.0.0.1:8787/v1/rooms/joined-room-id-12345/ws",
      lastSeq: 0,
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
      protocolVersion: 2,
      localSeatId: "seat-player",
      hostSeatId: "seat-host",
      seatCredentialVersion: 1,
    };
    const listRooms = vi.fn()
      .mockResolvedValueOnce([room])
      .mockResolvedValue([failedRoom, room]);
    mocks.getRepository.mockResolvedValue({
      listRooms,
      listModules: vi.fn(async () => []),
      getSetting: vi.fn(async () => undefined),
    } as unknown as LocalRepository);
    const invitation = encodeInvitationV2({
      protocolVersion: 2,
      roomId: "joined-room-id-12345",
      roomName: "雾港来信",
      seatId: "seat-player",
      role: "player",
      relayToken: "host-id-1234." + "s".repeat(43),
      seatSecret: "x".repeat(48),
      credentialVersion: 1,
      hostSeatId: "seat-host",
      hostPeerId: "host-id-1234",
      relayUrl: "ws://127.0.0.1:8787/v1/rooms/joined-room-id-12345/ws",
    });
    vi.stubGlobal("confirm", vi.fn(() => true));
    mocks.roomSessionStart.mockRejectedValue(new Error("relay unavailable"));
    useAppStore.setState({ currentRoom: room, activeView: "lobby", rooms: [room], connectionPhase: "live" });
    render(<App />);

    await waitFor(() => expect(listRooms).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: /我是玩家，加入朋友/ }));
    fireEvent.change(screen.getByLabelText("你的称呼"), { target: { value: "player" } });
    fireEvent.change(screen.getByLabelText("KP 发给你的邀请"), { target: { value: invitation } });
    fireEvent.click(screen.getByRole("button", { name: "加入调查" }));

    await screen.findByText(/请确认 KP 仍在线/, undefined, { timeout: 5_000 });
    expect(useAppStore.getState().currentRoom).toBeUndefined();
    expect(useAppStore.getState().activeView).toBe("lobby");
    expect(useAppStore.getState().connectionPhase).toBe("idle");
    expect(useAppStore.getState().relayConnected).toBe(false);
    expect(useAppStore.getState().rooms).toContainEqual(room);
    expect(useAppStore.getState().rooms).toContainEqual(failedRoom);
    expect(mocks.roomSessionStop).toHaveBeenCalledWith(failedRoom.id);
    expect(screen.getByText(/“雾港来信”和你的加入位置已经保存在本机/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "回到开始页" }));
    expect(screen.getByRole("heading", { name: "雾港来信" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "继续调查" }).length).toBeGreaterThan(0);
  });
});
