import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomTransport } from "./RoomTransport";

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(value: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket is not open");
    this.sent.push(value);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

describe("RoomTransport authenticated startup", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("waits for the matching ready response rather than resolving on TCP open", async () => {
    const transport = createTransport();
    let resolved = false;
    const started = transport.start().then(() => { resolved = true; });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    await Promise.resolve();
    expect(resolved).toBe(false);

    const join = JSON.parse(socket.sent[0]!) as { requestId: string };
    socket.receive({
      kind: "ready",
      protocolVersion: 1,
      ok: true,
      roomId: "room_abcdefghijklmnop",
      self: { peerId: "host-peer-1234", displayName: "Keeper", role: "host", status: "online" },
      peers: [],
      requestId: join.requestId,
    });
    await started;
    expect(resolved).toBe(true);
    transport.stop();
  });

  it("rejects an invalid join before opening a socket", async () => {
    const transport = createTransport({ token: "short" });
    await expect(transport.start()).rejects.toThrow();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("rejects a matching authentication error", async () => {
    const transport = createTransport();
    const started = transport.start();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    const join = JSON.parse(socket.sent[0]!) as { requestId: string };
    socket.receive({
      kind: "error",
      protocolVersion: 1,
      code: "INVALID_TOKEN",
      message: "invalid room token",
      requestId: join.requestId,
    });
    await expect(started).rejects.toThrow(/invalid room token/);
    transport.stop();
  });
});

function createTransport(overrides: Partial<ConstructorParameters<typeof RoomTransport>[0]> = {}): RoomTransport {
  return new RoomTransport({
    roomId: "room_abcdefghijklmnop",
    token: "01234567890123456789012345678901",
    relayUrl: "ws://127.0.0.1:8787/v1/rooms/room_abcdefghijklmnop",
    participant: { peerId: "host-peer-1234", displayName: "Keeper", role: "host" },
    hostPeerId: "host-peer-1234",
    ...overrides,
  });
}
