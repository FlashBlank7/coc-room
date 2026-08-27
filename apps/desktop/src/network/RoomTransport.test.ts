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

  close(_code?: number, _reason?: string): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

class FakeRTCDataChannel {
  readonly sent: string[] = [];
  readyState: RTCDataChannelState = "connecting";
  throwOnSend = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  send(value: string): void {
    if (this.throwOnSend) throw new Error("simulated DataChannel send failure");
    this.sent.push(value);
  }

  open(): void {
    this.readyState = "open";
    this.onopen?.();
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.onclose?.();
  }
}

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];

  readonly channels: FakeRTCDataChannel[] = [];
  readonly addedCandidates: RTCIceCandidateInit[] = [];
  readonly operations: string[] = [];
  connectionState: RTCPeerConnectionState = "new";
  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: { channel: FakeRTCDataChannel }) => void) | null = null;

  constructor(_configuration?: RTCConfiguration) {
    FakeRTCPeerConnection.instances.push(this);
  }

  createDataChannel(_label: string, _options?: RTCDataChannelInit): FakeRTCDataChannel {
    const channel = new FakeRTCDataChannel();
    this.channels.push(channel);
    return channel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.operations.push("createOffer");
    return { type: "offer", sdp: "fake-offer" };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    this.operations.push("createAnswer");
    return { type: "answer", sdp: "fake-answer" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
    this.operations.push(`setLocal:${description.type}`);
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
    this.operations.push(`setRemote:${description.type}`);
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.addedCandidates.push(candidate);
    this.operations.push(`addCandidate:${candidate.candidate}`);
  }

  close(): void {
    this.connectionState = "closed";
    this.onconnectionstatechange?.();
  }
}

const remotePlayer = {
  peerId: "player-peer-5678",
  displayName: "Investigator",
  role: "player" as const,
  status: "online" as const,
};

const wireMessage = {
  kind: "sync.request" as const,
  requestId: "00000000-0000-4000-8000-000000000001",
  lastSequence: 12,
};

describe("RoomTransport authenticated startup", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeRTCPeerConnection.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
  });

  afterEach(() => {
    vi.clearAllTimers();
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

describe("RoomTransport delivery paths", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeRTCPeerConnection.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("sends over an open DataChannel without also emitting a WSS relay", async () => {
    const transport = createTransport();
    const paths: string[] = [];
    transport.onPathChange = (peerId, path) => paths.push(`${peerId}:${path}`);
    const socket = await authenticateTransport(transport, [remotePlayer]);
    await flushAsyncWork();

    const connection = FakeRTCPeerConnection.instances[0]!;
    const channel = connection.channels[0]!;
    channel.open();

    expect(transport.sendToPeer(remotePlayer.peerId, wireMessage)).toBe(true);
    expect(channel.sent).toEqual([JSON.stringify(wireMessage)]);
    expect(sentEnvelopes(socket).filter(({ kind }) => kind === "relay")).toEqual([]);
    expect(paths.at(-1)).toBe(`${remotePlayer.peerId}:direct`);
    transport.stop();
  });

  it("uses the authenticated WSS relay while the DataChannel is not established", async () => {
    const transport = createTransport();
    const paths: string[] = [];
    transport.onPathChange = (peerId, path) => paths.push(`${peerId}:${path}`);
    const socket = await authenticateTransport(transport, [remotePlayer]);
    await flushAsyncWork();

    const channel = FakeRTCPeerConnection.instances[0]!.channels[0]!;
    expect(channel.readyState).toBe("connecting");
    expect(transport.sendToPeer(remotePlayer.peerId, wireMessage)).toBe(true);

    expect(channel.sent).toEqual([]);
    expect(sentEnvelopes(socket).filter(({ kind }) => kind === "relay")).toEqual([
      { kind: "relay", targetPeerId: remotePlayer.peerId, payload: wireMessage },
    ]);
    expect(paths.at(-1)).toBe(`${remotePlayer.peerId}:relay`);
    transport.stop();
  });

  it("can force the complete relay path without constructing WebRTC", async () => {
    const transport = createTransport({ forceRelay: true });
    const paths: string[] = [];
    transport.onPathChange = (peerId, path) => paths.push(`${peerId}:${path}`);
    const socket = await authenticateTransport(transport, [remotePlayer]);

    expect(FakeRTCPeerConnection.instances).toHaveLength(0);
    expect(paths.at(-1)).toBe(`${remotePlayer.peerId}:relay`);
    transport.broadcast(wireMessage);
    expect(sentEnvelopes(socket).filter(({ kind }) => kind === "relay")).toEqual([
      { kind: "relay", targetPeerId: remotePlayer.peerId, payload: wireMessage },
    ]);
    transport.stop();
  });

  it("falls back to WSS relay when an open DataChannel throws during send", async () => {
    const transport = createTransport();
    const paths: string[] = [];
    transport.onPathChange = (peerId, path) => paths.push(`${peerId}:${path}`);
    const socket = await authenticateTransport(transport, [remotePlayer]);
    await flushAsyncWork();

    const channel = FakeRTCPeerConnection.instances[0]!.channels[0]!;
    channel.open();
    channel.throwOnSend = true;

    expect(transport.sendToPeer(remotePlayer.peerId, wireMessage)).toBe(true);
    expect(sentEnvelopes(socket).filter(({ kind }) => kind === "relay")).toEqual([
      { kind: "relay", targetPeerId: remotePlayer.peerId, payload: wireMessage },
    ]);
    expect(paths).toContain(`${remotePlayer.peerId}:direct`);
    expect(paths.at(-1)).toBe(`${remotePlayer.peerId}:relay`);
    transport.stop();
  });

  it("marks relay-only peers offline as soon as the relay socket closes", async () => {
    const transport = createTransport();
    const relayStates: boolean[] = [];
    const paths: string[] = [];
    const presence: string[][] = [];
    transport.onRelayStateChange = (connected) => relayStates.push(connected);
    transport.onPathChange = (peerId, path) => paths.push(`${peerId}:${path}`);
    transport.onPresence = (participants) => presence.push(participants.map(({ peerId }) => peerId));
    const socket = await authenticateTransport(transport, [remotePlayer]);
    await flushAsyncWork();

    expect(relayStates).toEqual([true]);
    socket.close();

    expect(relayStates).toEqual([true, false]);
    expect(paths.at(-1)).toBe(`${remotePlayer.peerId}:offline`);
    expect(presence.at(-1)).toEqual(["host-peer-1234"]);
    expect(transport.sendToPeer(remotePlayer.peerId, wireMessage)).toBe(false);
    transport.stop();
  });

  it("keeps an open direct channel usable while the relay reconnects", async () => {
    const transport = createTransport();
    const relayStates: boolean[] = [];
    const presence: string[][] = [];
    transport.onRelayStateChange = (connected) => relayStates.push(connected);
    transport.onPresence = (participants) => presence.push(participants.map(({ peerId }) => peerId));
    const socket = await authenticateTransport(transport, [remotePlayer]);
    await flushAsyncWork();
    const channel = FakeRTCPeerConnection.instances[0]!.channels[0]!;
    channel.open();

    socket.close();

    expect(relayStates).toEqual([true, false]);
    expect(presence.at(-1)).toContain(remotePlayer.peerId);
    expect(transport.sendToPeer(remotePlayer.peerId, wireMessage)).toBe(true);
    expect(channel.sent.at(-1)).toBe(JSON.stringify(wireMessage));
    transport.stop();
  });

  it("keeps a healthy direct peer when the Worker reports its transient relay disconnect", async () => {
    const transport = createTransport();
    const paths: string[] = [];
    const presence: string[][] = [];
    transport.onPathChange = (peerId, path) => paths.push(`${peerId}:${path}`);
    transport.onPresence = (participants) => presence.push(participants.map(({ peerId }) => peerId));
    const socket = await authenticateTransport(transport, [remotePlayer]);
    await flushAsyncWork();
    const connection = FakeRTCPeerConnection.instances[0]!;
    const channel = connection.channels[0]!;
    channel.open();

    socket.receive({
      kind: "presence",
      protocolVersion: 1,
      action: "left",
      peer: { peerId: remotePlayer.peerId },
    });

    expect(connection.connectionState).not.toBe("closed");
    expect(presence.at(-1)).toContain(remotePlayer.peerId);
    expect(paths.at(-1)).toBe(`${remotePlayer.peerId}:direct`);
    expect(transport.sendToPeer(remotePlayer.peerId, wireMessage)).toBe(true);
    expect(channel.sent.at(-1)).toBe(JSON.stringify(wireMessage));

    socket.receive({
      kind: "presence",
      protocolVersion: 1,
      action: "joined",
      peer: remotePlayer,
    });
    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
    expect(paths.at(-1)).toBe(`${remotePlayer.peerId}:direct`);
    transport.stop();
  });

  it("removes a peer after both its relay membership and direct channel are gone", async () => {
    const transport = createTransport();
    const paths: string[] = [];
    const presence: string[][] = [];
    transport.onPathChange = (peerId, path) => paths.push(`${peerId}:${path}`);
    transport.onPresence = (participants) => presence.push(participants.map(({ peerId }) => peerId));
    const socket = await authenticateTransport(transport, [remotePlayer]);
    await flushAsyncWork();
    const connection = FakeRTCPeerConnection.instances[0]!;
    const channel = connection.channels[0]!;
    channel.open();

    socket.receive({
      kind: "presence",
      protocolVersion: 1,
      action: "left",
      peer: { peerId: remotePlayer.peerId },
    });
    channel.close();

    expect(connection.connectionState).toBe("closed");
    expect(presence.at(-1)).toEqual(["host-peer-1234"]);
    expect(paths.at(-1)).toBe(`${remotePlayer.peerId}:offline`);
    transport.stop();
  });

  it("fragments a large Unicode relay message into Worker-safe frames and reassembles it once", async () => {
    const transport = createTransport();
    const socket = await authenticateTransport(transport, [remotePlayer]);
    await flushAsyncWork();
    const delivered = vi.fn();
    transport.onWireMessage = delivered;
    const message = largeUnicodeWireMessage();

    expect(transport.sendToPeer(remotePlayer.peerId, message)).toBe(true);
    const fragmentEnvelopes = sentEnvelopes(socket).filter(
      (envelope) =>
        envelope.kind === "relay" &&
        (envelope.payload as { kind?: unknown } | undefined)?.kind === "transport.fragment",
    );
    expect(fragmentEnvelopes.length).toBeGreaterThan(2);
    for (const envelope of fragmentEnvelopes) {
      expect(new TextEncoder().encode(JSON.stringify(envelope)).byteLength).toBeLessThanOrEqual(64 * 1024);
      const forwarded = {
        kind: "relay",
        protocolVersion: 1,
        fromPeerId: remotePlayer.peerId,
        payload: envelope.payload,
      };
      expect(new TextEncoder().encode(JSON.stringify(forwarded)).byteLength).toBeLessThanOrEqual(64 * 1024);
    }

    const first = fragmentEnvelopes[0]!;
    socket.receive({
      kind: "relay",
      protocolVersion: 1,
      fromPeerId: remotePlayer.peerId,
      payload: first.payload,
    });
    socket.receive({
      kind: "relay",
      protocolVersion: 1,
      fromPeerId: remotePlayer.peerId,
      payload: first.payload,
    });
    for (const envelope of fragmentEnvelopes.slice(1).reverse()) {
      socket.receive({
        kind: "relay",
        protocolVersion: 1,
        fromPeerId: remotePlayer.peerId,
        payload: envelope.payload,
      });
    }
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveBeenCalledWith(remotePlayer.peerId, message);

    for (const envelope of fragmentEnvelopes) {
      socket.receive({
        kind: "relay",
        protocolVersion: 1,
        fromPeerId: remotePlayer.peerId,
        payload: envelope.payload,
      });
    }
    expect(delivered).toHaveBeenCalledTimes(1);
    transport.stop();
  });

  it("buffers an early ICE candidate and flushes it after the offer sets a remote description", async () => {
    const transport = createTransport();
    const socket = await authenticateTransport(transport);
    const candidate = {
      candidate: "candidate:early",
      sdpMid: "0",
      sdpMLineIndex: 0,
    };

    socket.receive({
      kind: "signal",
      protocolVersion: 1,
      fromPeerId: remotePlayer.peerId,
      data: { type: "candidate", candidate },
    });
    await flushAsyncWork();

    const connection = FakeRTCPeerConnection.instances[0]!;
    expect(connection.remoteDescription).toBeNull();
    expect(connection.addedCandidates).toEqual([]);

    socket.receive({
      kind: "signal",
      protocolVersion: 1,
      fromPeerId: remotePlayer.peerId,
      data: { type: "offer", description: { type: "offer", sdp: "remote-offer" } },
    });
    await flushAsyncWork();

    expect(connection.addedCandidates).toEqual([candidate]);
    expect(connection.operations).toEqual([
      "setRemote:offer",
      "addCandidate:candidate:early",
      "createAnswer",
      "setLocal:answer",
    ]);
    expect(sentEnvelopes(socket)).toContainEqual({
      kind: "signal",
      targetPeerId: remotePlayer.peerId,
      data: { type: "answer", description: { type: "answer", sdp: "fake-answer" } },
    });
    transport.stop();
  });
});

async function authenticateTransport(
  transport: RoomTransport,
  peers: typeof remotePlayer[] = [],
): Promise<FakeWebSocket> {
  const started = transport.start();
  const socket = FakeWebSocket.instances[0]!;
  socket.open();
  const join = JSON.parse(socket.sent[0]!) as { requestId: string };
  socket.receive({
    kind: "ready",
    protocolVersion: 1,
    ok: true,
    roomId: "room_abcdefghijklmnop",
    self: { peerId: "host-peer-1234", displayName: "Keeper", role: "host", status: "online" },
    peers,
    requestId: join.requestId,
  });
  await started;
  return socket;
}

function sentEnvelopes(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent.slice(1).map((value) => JSON.parse(value) as Record<string, unknown>);
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

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

function largeUnicodeWireMessage() {
  return {
    kind: "event" as const,
    event: {
      protocolVersion: 1 as const,
      roomId: "room_abcdefghijklmnop",
      eventId: "00000000-0000-4000-8000-000000000301",
      sequence: 1,
      sender: { peerId: remotePlayer.peerId, displayName: "调查员", role: "player" as const },
      type: "content.revealed" as const,
      occurredAt: "2026-08-28T00:00:00.000Z",
      payload: {
        moduleId: "module-butterfly",
        revision: 1,
        contentId: "handout-butterfly",
        contentType: "handout" as const,
        title: "见世之蝶",
        body: "见🦋".repeat(15_000),
      },
    },
  };
}
