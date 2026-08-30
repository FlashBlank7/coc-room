import { describe, expect, it } from "vitest";
import type { Coc7Character, ParticipantV1, RoomEventViewV2, SeatV2 } from "@coc-room/protocol";
import { MemoryRepository, type RoomRecord } from "../data/repository";
import { saveLocalSeatSecret } from "../lib/seat-credentials";
import { RoomCommandRejectedError, RoomSessionV2, paginateRoomEventViewsV2 } from "./RoomSessionV2";
import type { ConnectionPath, RoomWireMessage } from "./RoomTransport";

class MemoryTransportHub {
  readonly messages: Array<{ from: string; to: string; message: RoomWireMessage }> = [];
  dropOnce?: (from: string, to: string, message: RoomWireMessage) => boolean;
  private readonly transports = new Map<string, MemoryTransportV2>();

  create(participant: ParticipantV1, hostPeerId: string): MemoryTransportV2 {
    const transport = new MemoryTransportV2(this, participant, hostPeerId);
    this.transports.set(participant.peerId, transport);
    return transport;
  }

  presence(): void {
    const online = [...this.transports.values()].filter((transport) => transport.started);
    const participants = online.map(({ participant }) => ({ ...participant, status: "online" as const }));
    for (const transport of online) transport.onPresence?.(participants);
  }

  deliver(from: string, to: string, message: RoomWireMessage): boolean {
    const target = this.transports.get(to);
    if (!target?.started) return false;
    this.messages.push({ from, to, message: structuredClone(message) });
    if (this.dropOnce?.(from, to, message)) {
      this.dropOnce = undefined;
      return true;
    }
    target.onWireMessage?.(from, structuredClone(message));
    return true;
  }
}

class MemoryTransportV2 {
  onWireMessage?: (fromPeerId: string, message: RoomWireMessage) => void;
  onPresence?: (participants: ParticipantV1[]) => void;
  onPathChange?: (peerId: string, path: ConnectionPath) => void;
  onRelayStateChange?: (connected: boolean) => void;
  onError?: (message: string) => void;
  started = false;

  constructor(
    private readonly hub: MemoryTransportHub,
    readonly participant: ParticipantV1,
    private readonly hostPeerId: string,
  ) {}

  async start(): Promise<void> {
    this.started = true;
    this.onRelayStateChange?.(true);
    this.hub.presence();
  }

  stop(): void {
    this.started = false;
    this.onRelayStateChange?.(false);
    this.hub.presence();
  }

  sendToHost(message: RoomWireMessage): boolean {
    return this.hub.deliver(this.participant.peerId, this.hostPeerId, message);
  }

  sendToPeer(peerId: string, message: RoomWireMessage): boolean {
    return this.hub.deliver(this.participant.peerId, peerId, message);
  }
}

describe("RoomSessionV2", () => {
  it("authenticates independent seats before data and keeps a secret payload out of the other SQLite view", async () => {
    const hub = new MemoryTransportHub();
    const hostRepository = new MemoryRepository();
    const hostRoom = roomRecord("host-peer-v2", "host", "seat-host");
    const hostTransport = hub.create(participant(hostRoom, "KP"), hostRoom.hostPeerId);
    const host = new RoomSessionV2({
      room: hostRoom,
      displayName: "KP",
      repository: hostRepository,
      transport: hostTransport,
    });
    await host.start();
    const aliceInvite = await host.issueSeatInvitation("Alice", "seat-alice");
    const bobInvite = await host.issueSeatInvitation("Bob", "seat-bob");

    const aliceRepository = new MemoryRepository();
    const aliceRoom = playerRoom(aliceInvite, "alice-peer-v2");
    await saveLocalSeatSecret(aliceRoom.id, aliceInvite.seatId, aliceInvite.seatSecret);
    const aliceTransport = hub.create(participant(aliceRoom, "Untrusted Alice name"), hostRoom.hostPeerId);
    const alice = new RoomSessionV2({
      room: aliceRoom,
      displayName: "Alice local",
      repository: aliceRepository,
      transport: aliceTransport,
    });
    const authErrors: string[] = [];
    alice.onError = (message) => authErrors.push(`alice:${message}`);
    await alice.start();

    const bobRepository = new MemoryRepository();
    const bobRoom = playerRoom(bobInvite, "bob-peer-v2");
    await saveLocalSeatSecret(bobRoom.id, bobInvite.seatId, bobInvite.seatSecret);
    const bobTransport = hub.create(participant(bobRoom, "Bob relay"), hostRoom.hostPeerId);
    const bob = new RoomSessionV2({
      room: bobRoom,
      displayName: "Bob local",
      repository: bobRepository,
      transport: bobTransport,
    });
    bob.onError = (message) => authErrors.push(`bob:${message}`);
    await bob.start();
    try {
      await eventually(() => alice.isAuthenticated && bob.isAuthenticated);
    } catch {
      throw new Error(JSON.stringify({
        alice: alice.isAuthenticated,
        bob: bob.isAuthenticated,
        authErrors,
        messages: hub.messages.map(({ from, to, message }) => `${from}->${to}:${message.kind}`),
      }));
    }

    await host.submit({
      type: "chat.message",
      audience: { kind: "seats", seatIds: [aliceInvite.seatId] },
      payload: { message: "诱饵秘密：银钥匙在钟内", format: "plain" },
    });
    await eventually(() => alice.lastContiguousSequence === 1 && bob.lastContiguousSequence === 1);

    expect((await aliceRepository.listEventViewsV2(hostRoom.id))[0]?.view).toBe("full");
    expect((await bobRepository.listEventViewsV2(hostRoom.id))[0]).toMatchObject({
      view: "redacted",
      sequence: 1,
    });
    const bobDiskProjection = JSON.stringify(await bobRepository.listEventViewsV2(hostRoom.id));
    expect(bobDiskProjection).not.toContain("chat.message");
    expect(bobDiskProjection).not.toContain("银钥匙");

    const outboundToAlice = hub.messages.filter(({ from, to }) => from === hostRoom.hostPeerId && to === aliceRoom.localPeerId);
    const authResultIndex = outboundToAlice.findIndex(({ message }) => message.kind === "v2.auth.result" && message.ok);
    const firstRoomDataIndex = outboundToAlice.findIndex(({ message }) =>
      message.kind === "v2.event" || message.kind === "v2.sync.page",
    );
    expect(authResultIndex).toBeGreaterThanOrEqual(0);
    expect(firstRoomDataIndex).toBeGreaterThan(authResultIndex);

    alice.stop();
    bob.stop();
    host.stop();
  });

  it("keeps issued seats visible while offline and refreshes presence after invitation changes", async () => {
    const hub = new MemoryTransportHub();
    const hostRoom = roomRecord("host-seat-roster-v2", "host", "seat-host-roster");
    const host = new RoomSessionV2({
      room: hostRoom,
      displayName: "KP",
      repository: new MemoryRepository(),
      transport: hub.create(participant(hostRoom, "KP"), hostRoom.hostPeerId),
    });
    const snapshots: SeatV2[][] = [];
    host.onPresence = (seats) => snapshots.push(structuredClone(seats));
    await host.start();

    const invitation = await host.issueSeatInvitation("尚未加入的 Alice", "seat-offline-alice");
    expect(invitation.roomName).toBe(hostRoom.name);
    expect(snapshots.at(-1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ seatId: hostRoom.hostSeatId, role: "host", peerId: hostRoom.localPeerId }),
      expect.objectContaining({ seatId: invitation.seatId, role: "player", displayName: "尚未加入的 Alice" }),
    ]));
    expect(snapshots.at(-1)?.find(({ seatId }) => seatId === invitation.seatId)?.peerId).toBeUndefined();

    await saveLocalSeatSecret(invitation.roomId, invitation.seatId, invitation.seatSecret);
    const aliceRoom = playerRoom(invitation, "alice-roster-peer");
    const alice = new RoomSessionV2({
      room: aliceRoom,
      displayName: "Alice",
      repository: new MemoryRepository(),
      transport: hub.create(participant(aliceRoom, "Alice"), hostRoom.hostPeerId),
    });
    await alice.start();
    await eventually(() => snapshots.at(-1)?.some(({ seatId, peerId }) => (
      seatId === invitation.seatId && peerId === aliceRoom.localPeerId
    )) === true);

    alice.stop();
    await eventually(() => {
      const seat = snapshots.at(-1)?.find(({ seatId }) => seatId === invitation.seatId);
      return seat !== undefined && seat.peerId === undefined;
    });

    const rotated = await host.rotateSeatInvitation(invitation.seatId);
    expect(rotated.credentialVersion).toBe(2);
    expect(rotated.roomName).toBe(hostRoom.name);
    expect(snapshots.at(-1)?.some(({ seatId }) => seatId === invitation.seatId)).toBe(true);

    await host.disableSeat(invitation.seatId);
    expect(snapshots.at(-1)?.some(({ seatId }) => seatId === invitation.seatId)).toBe(false);
    host.stop();
  });

  it("reconnects a stable seat from a new peer and resumes at its contiguous cursor", async () => {
    const hub = new MemoryTransportHub();
    const hostRoom = roomRecord("host-reconnect-v2", "host", "seat-host-reconnect");
    const host = new RoomSessionV2({
      room: hostRoom,
      displayName: "KP",
      repository: new MemoryRepository(),
      transport: hub.create(participant(hostRoom, "KP"), hostRoom.hostPeerId),
    });
    await host.start();
    const invitation = await host.issueSeatInvitation("Stable Alice", "seat-stable-alice");
    await saveLocalSeatSecret(invitation.roomId, invitation.seatId, invitation.seatSecret);
    const playerRepository = new MemoryRepository();
    const firstRoom = playerRoom(invitation, "alice-old-peer");
    const first = new RoomSessionV2({
      room: firstRoom,
      displayName: "Alice",
      repository: playerRepository,
      transport: hub.create(participant(firstRoom, "Alice"), hostRoom.hostPeerId),
    });
    await first.start();
    await eventually(() => first.isAuthenticated);
    await host.submit({
      type: "chat.message",
      audience: { kind: "room" },
      payload: { message: "before reconnect", format: "plain" },
    });
    await eventually(() => first.lastContiguousSequence === 1);
    first.stop();

    const secondRoom = { ...firstRoom, localPeerId: "alice-new-peer", updatedAt: new Date().toISOString() };
    const second = new RoomSessionV2({
      room: secondRoom,
      displayName: "Alice renamed locally",
      repository: playerRepository,
      transport: hub.create(participant(secondRoom, "Alice renamed in relay"), hostRoom.hostPeerId),
    });
    await second.start();
    await eventually(() => second.isAuthenticated);
    expect(second.lastContiguousSequence).toBe(1);

    await host.submit({
      type: "chat.message",
      audience: { kind: "room" },
      payload: { message: "after reconnect", format: "plain" },
    });
    await eventually(() => second.lastContiguousSequence === 2);
    expect((await playerRepository.listEventViewsV2(hostRoom.id))).toHaveLength(2);

    second.stop();
    host.stop();
  });

  it("reauthenticates the same live session after the relay connection returns", async () => {
    const hub = new MemoryTransportHub();
    const hostRoom = roomRecord("host-live-reauth-v2", "host", "seat-host-live-reauth");
    const hostTransport = hub.create(participant(hostRoom, "KP"), hostRoom.hostPeerId);
    const host = new RoomSessionV2({
      room: hostRoom,
      displayName: "KP",
      repository: new MemoryRepository(),
      transport: hostTransport,
    });
    await host.start();
    const invitation = await host.issueSeatInvitation("Alice", "seat-live-reauth-alice");
    await saveLocalSeatSecret(invitation.roomId, invitation.seatId, invitation.seatSecret);
    const playerRoomRecord = playerRoom(invitation, "alice-live-reauth-peer");
    const player = new RoomSessionV2({
      room: playerRoomRecord,
      displayName: "Alice",
      repository: new MemoryRepository(),
      transport: hub.create(participant(playerRoomRecord, "Alice"), hostRoom.hostPeerId),
    });
    await player.start();
    await eventually(() => player.isAuthenticated);

    hostTransport.stop();
    await eventually(() => !player.isAuthenticated);
    await hostTransport.start();
    await eventually(() => player.isAuthenticated);

    await host.submit({
      type: "chat.message",
      audience: { kind: "room" },
      payload: { message: "reauthenticated", format: "plain" },
    });
    await eventually(() => player.lastContiguousSequence === 1);
    expect(player.world.lastSequence).toBe(1);

    player.stop();
    host.stop();
  });

  it("paginates at 500 events and enforces the 4 MiB page ceiling", () => {
    const views = Array.from({ length: 501 }, (_, index): RoomEventViewV2 => ({
      view: "redacted",
      protocolVersion: 2,
      roomId: "room_v2_pagination",
      eventId: uuidFor(index + 1),
      sequence: index + 1,
      occurredAt: "2026-01-01T00:00:00.000Z",
    }));
    const pages = paginateRoomEventViewsV2(views);
    expect(pages.map((page) => page.length)).toEqual([500, 1]);
    for (const page of pages) {
      const envelope = { kind: "v2.sync.page", requestId: "00000000-0000-4000-8000-000000000000", pageIndex: 99_999, pageCount: 100_000, views: page };
      expect(new TextEncoder().encode(JSON.stringify(envelope)).byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
  });

  it("retries only the unacknowledged sync page and accepts a duplicate-page ACK", async () => {
    const hub = new MemoryTransportHub();
    const hostRoom = roomRecord("host-sync-retry-v2", "host", "seat-host-sync");
    const host = new RoomSessionV2({ room: hostRoom, displayName: "KP", repository: new MemoryRepository(), transport: hub.create(participant(hostRoom, "KP"), hostRoom.hostPeerId), syncPageTimeoutMs: 20 });
    await host.start();
    await host.submit({ type: "chat.message", audience: { kind: "room" }, payload: { message: "history", format: "plain" } });
    const invite = await host.issueSeatInvitation("Alice", "seat-sync-retry");
    await saveLocalSeatSecret(hostRoom.id, invite.seatId, invite.seatSecret);
    const aliceRoom = playerRoom(invite, "sync-retry-peer");
    const alice = new RoomSessionV2({ room: aliceRoom, displayName: "Alice", repository: new MemoryRepository(), transport: hub.create(participant(aliceRoom, "Alice"), hostRoom.hostPeerId), syncPageTimeoutMs: 20 });
    hub.dropOnce = (from, _to, message) => from === aliceRoom.localPeerId && message.kind === "v2.sync.ack";
    await alice.start();
    await eventually(() => alice.lastContiguousSequence === 1);
    await eventually(() => hub.messages.filter(({ from, to, message }) => from === hostRoom.hostPeerId && to === aliceRoom.localPeerId && message.kind === "v2.sync.page" && message.pageIndex === 0).length >= 2);
    const pages = hub.messages.filter(({ from, to, message }) => from === hostRoom.hostPeerId && to === aliceRoom.localPeerId && message.kind === "v2.sync.page");
    expect(pages.every(({ message }) => message.kind === "v2.sync.page" && message.pageIndex === 0)).toBe(true);
    expect(hub.messages.filter(({ from, message }) => from === aliceRoom.localPeerId && message.kind === "v2.sync.request")).toHaveLength(1);
    alice.stop(); host.stop();
  });

  it("serves an asset only after that seat received a full referencing event", async () => {
    const hub = new MemoryTransportHub();
    const hostRoom = roomRecord("host-peer-v2", "host", "seat-host");
    const host = new RoomSessionV2({
      room: hostRoom,
      displayName: "KP",
      repository: new MemoryRepository(),
      transport: hub.create(participant(hostRoom, "KP"), hostRoom.hostPeerId),
    });
    await host.start();
    const aliceInvite = await host.issueSeatInvitation("Alice", "seat-asset-alice");
    const bobInvite = await host.issueSeatInvitation("Bob", "seat-asset-bob");
    const aliceRoom = playerRoom(aliceInvite, "asset-alice-peer");
    const bobRoom = playerRoom(bobInvite, "asset-bob-peer");
    await saveLocalSeatSecret(hostRoom.id, aliceInvite.seatId, aliceInvite.seatSecret);
    await saveLocalSeatSecret(hostRoom.id, bobInvite.seatId, bobInvite.seatSecret);
    const alice = new RoomSessionV2({ room: aliceRoom, displayName: "Alice", repository: new MemoryRepository(), transport: hub.create(participant(aliceRoom, "Alice"), hostRoom.hostPeerId) });
    const bob = new RoomSessionV2({ room: bobRoom, displayName: "Bob", repository: new MemoryRepository(), transport: hub.create(participant(bobRoom, "Bob"), hostRoom.hostPeerId) });
    await alice.start();
    await bob.start();
    await eventually(() => alice.isAuthenticated && bob.isAuthenticated);

    const bytes = new TextEncoder().encode("authorized audio bytes");
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
    const asset = { schemaVersion: 1 as const, assetId: `sha256:${hash}` as const, mediaType: "audio/mpeg", byteLength: bytes.byteLength };
    host.enableAssetTransfers({
      readLocalChunk: async ({ offset, length }) => bytes.slice(offset, offset + length),
      finalizeReceivedAsset: async () => { throw new Error("host must not receive its own asset"); },
    });
    let aliceReceived = "";
    const bobErrors: string[] = [];
    alice.enableAssetTransfers({
      readLocalChunk: async () => new Uint8Array(),
      finalizeReceivedAsset: async ({ chunks }) => { aliceReceived = new TextDecoder().decode(concatChunks(chunks)); },
    });
    bob.enableAssetTransfers({
      readLocalChunk: async () => new Uint8Array(),
      finalizeReceivedAsset: async () => { throw new Error("unauthorized asset finalized"); },
      onEvent: (event) => { if (event.kind === "error") bobErrors.push(event.code); },
    });

    await host.submit({
      type: "artifact.upserted",
      audience: { kind: "seats", seatIds: [aliceInvite.seatId] },
      payload: {
        artifact: {
          schemaVersion: 2,
          artifactId: "artifact-audio-secret",
          revision: 1,
          kind: "ambience-audio",
          title: "Alice audio",
          description: "",
          body: "",
          attachments: [asset],
          audience: { kind: "seats", seatIds: [aliceInvite.seatId] },
          locked: true,
          archived: false,
          extensions: {},
        },
      },
    });
    await eventually(() => alice.lastContiguousSequence === 1 && bob.lastContiguousSequence === 1);
    alice.requestAssetFromHost(asset);
    bob.requestAssetFromHost(asset);
    await eventually(() => aliceReceived.length > 0 && bobErrors.length > 0);
    expect(aliceReceived).toBe("authorized audio bytes");
    expect(bobErrors).toContain("FORBIDDEN");

    alice.stop();
    bob.stop();
    host.stop();
  });

  it("waits for every online audience seat to confirm an exact prefetched asset", async () => {
    const hub = new MemoryTransportHub();
    const hostRepository = new MemoryRepository();
    const hostRoom = roomRecord("host-audio-ready", "host", "seat-host-audio-ready");
    const host = new RoomSessionV2({
      room: hostRoom,
      displayName: "KP",
      repository: hostRepository,
      transport: hub.create(participant(hostRoom, "KP"), hostRoom.hostPeerId),
    });
    await host.start();
    const aliceInvite = await host.issueSeatInvitation("Alice", "seat-audio-ready-alice");
    const bobInvite = await host.issueSeatInvitation("Bob", "seat-audio-ready-bob");
    await saveLocalSeatSecret(hostRoom.id, aliceInvite.seatId, aliceInvite.seatSecret);
    await saveLocalSeatSecret(hostRoom.id, bobInvite.seatId, bobInvite.seatSecret);
    const aliceRoom = playerRoom(aliceInvite, "audio-ready-alice-peer");
    const bobRoom = playerRoom(bobInvite, "audio-ready-bob-peer");
    const alice = new RoomSessionV2({ room: aliceRoom, displayName: "Alice", repository: new MemoryRepository(), transport: hub.create(participant(aliceRoom, "Alice"), hostRoom.hostPeerId) });
    const bob = new RoomSessionV2({ room: bobRoom, displayName: "Bob", repository: new MemoryRepository(), transport: hub.create(participant(bobRoom, "Bob"), hostRoom.hostPeerId) });
    await alice.start();
    await bob.start();
    await eventually(() => alice.isAuthenticated && bob.isAuthenticated);

    const asset = {
      schemaVersion: 1 as const,
      assetId: `sha256:${"c".repeat(64)}` as const,
      mediaType: "audio/ogg",
      byteLength: 1_024,
    };
    await host.submit({
      type: "artifact.upserted",
      audience: { kind: "room" },
      payload: {
        artifact: {
          schemaVersion: 2,
          artifactId: "artifact-audio-ready",
          revision: 1,
          kind: "ambience-audio",
          title: "Ready audio",
          description: "",
          body: "",
          attachments: [asset],
          audience: { kind: "room" },
          locked: true,
          archived: false,
          extensions: {},
        },
      },
    });
    await eventually(() => alice.lastContiguousSequence === 1 && bob.lastContiguousSequence === 1);

    let settled = false;
    const ready = host.waitForAssetReady(asset, { kind: "room" }, 5_000)
      .then(() => { settled = true; });
    expect(alice.announceAssetReady(asset)).toBe(true);
    await eventually(() => hub.messages.some(({ from, message }) => from === aliceRoom.localPeerId && message.kind === "asset.ready"));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(bob.announceAssetReady(asset)).toBe(true);
    await ready;
    expect(settled).toBe(true);

    alice.stop();
    bob.stop();
    host.stop();
  });

  it("keeps exact seat asset grants across a host session restart", async () => {
    const hub = new MemoryTransportHub();
    const hostRepository = new MemoryRepository();
    const hostRoom = roomRecord("host-restart-assets", "host", "seat-host-restart-assets");
    const firstHost = new RoomSessionV2({
      room: hostRoom,
      displayName: "KP",
      repository: hostRepository,
      transport: hub.create(participant(hostRoom, "KP"), hostRoom.hostPeerId),
    });
    await firstHost.start();
    const invitation = await firstHost.issueSeatInvitation("Alice", "seat-restart-asset-alice");
    await saveLocalSeatSecret(hostRoom.id, invitation.seatId, invitation.seatSecret);
    const aliceRoom = playerRoom(invitation, "restart-asset-alice-peer");
    const alice = new RoomSessionV2({
      room: aliceRoom,
      displayName: "Alice",
      repository: new MemoryRepository(),
      transport: hub.create(participant(aliceRoom, "Alice"), hostRoom.hostPeerId),
    });
    await alice.start();
    await eventually(() => alice.isAuthenticated);

    const bytes = new TextEncoder().encode("restart-persistent asset grant");
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
    const asset = { schemaVersion: 1 as const, assetId: `sha256:${hash}` as const, mediaType: "audio/mpeg" as const, byteLength: bytes.byteLength };
    await firstHost.submit({
      type: "artifact.upserted",
      audience: { kind: "seats", seatIds: [invitation.seatId] },
      payload: { artifact: { schemaVersion: 2, artifactId: "restart-grant-artifact", revision: 1, kind: "file", title: "Restart grant", description: "", body: "", attachments: [asset], audience: { kind: "seats", seatIds: [invitation.seatId] }, locked: false, archived: false, extensions: {} } },
    });
    await eventually(() => alice.lastContiguousSequence === 1);
    firstHost.stop();
    await eventually(() => !alice.isAuthenticated);

    const restartedHost = new RoomSessionV2({
      room: hostRoom,
      displayName: "KP",
      repository: hostRepository,
      transport: hub.create(participant(hostRoom, "KP"), hostRoom.hostPeerId),
    });
    restartedHost.enableAssetTransfers({
      readLocalChunk: async ({ offset, length }) => bytes.slice(offset, offset + length),
      finalizeReceivedAsset: async () => { throw new Error("host should only serve this asset"); },
    });
    let received = "";
    const errors: string[] = [];
    alice.enableAssetTransfers({
      readLocalChunk: async () => new Uint8Array(),
      finalizeReceivedAsset: async ({ chunks }) => { received = new TextDecoder().decode(concatChunks(chunks)); },
      onEvent: (event) => { if (event.kind === "error") errors.push(event.code); },
    });
    await restartedHost.start();
    await eventually(() => alice.isAuthenticated);
    alice.requestAssetFromHost(asset);
    await eventually(() => received.length > 0);
    expect(received).toBe("restart-persistent asset grant");

    alice.requestAssetFromHost({ ...asset, mediaType: "audio/ogg" });
    await eventually(() => errors.includes("FORBIDDEN"));
    alice.stop();
    restartedHost.stop();
  });

  it("pulls a player attachment into the host before sequencing and then serves it to another seat", async () => {
    const hub = new MemoryTransportHub();
    const hostRoom = roomRecord("host-upload-v2", "host", "seat-host");
    const host = new RoomSessionV2({ room: hostRoom, displayName: "KP", repository: new MemoryRepository(), transport: hub.create(participant(hostRoom, "KP"), hostRoom.hostPeerId) });
    await host.start();
    const aliceInvite = await host.issueSeatInvitation("Alice", "seat-upload-alice");
    const bobInvite = await host.issueSeatInvitation("Bob", "seat-upload-bob");
    await saveLocalSeatSecret(hostRoom.id, aliceInvite.seatId, aliceInvite.seatSecret);
    await saveLocalSeatSecret(hostRoom.id, bobInvite.seatId, bobInvite.seatSecret);
    const aliceRoom = playerRoom(aliceInvite, "upload-alice-peer");
    const bobRoom = playerRoom(bobInvite, "upload-bob-peer");
    const alice = new RoomSessionV2({ room: aliceRoom, displayName: "Alice", repository: new MemoryRepository(), transport: hub.create(participant(aliceRoom, "Alice"), hostRoom.hostPeerId) });
    const bob = new RoomSessionV2({ room: bobRoom, displayName: "Bob", repository: new MemoryRepository(), transport: hub.create(participant(bobRoom, "Bob"), hostRoom.hostPeerId) });
    await alice.start(); await bob.start();
    await eventually(() => alice.isAuthenticated && bob.isAuthenticated);

    const bytes = new TextEncoder().encode("player-owned attachment");
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
    const asset = { schemaVersion: 1 as const, assetId: `sha256:${hash}` as const, mediaType: "audio/mpeg", byteLength: bytes.byteLength };
    let hostBytes: Uint8Array | undefined;
    host.enableAssetTransfers({
      hasLocalAsset: async () => hostBytes !== undefined,
      readLocalChunk: async ({ offset, length }) => hostBytes!.slice(offset, offset + length),
      finalizeReceivedAsset: async ({ chunks }) => { hostBytes = concatChunks(chunks); },
    });
    let aliceReads = 0;
    alice.enableAssetTransfers({ readLocalChunk: async ({ offset, length }) => { aliceReads += 1; return bytes.slice(offset, offset + length); }, finalizeReceivedAsset: async () => undefined, hasLocalAsset: async () => true });
    let bobReceived = "";
    bob.enableAssetTransfers({ readLocalChunk: async () => new Uint8Array(), finalizeReceivedAsset: async ({ chunks }) => { bobReceived = new TextDecoder().decode(concatChunks(chunks)); } });

    await alice.submitConfirmed({ type: "artifact.upserted", audience: { kind: "room" }, payload: { artifact: { schemaVersion: 2, artifactId: "player-upload-artifact", revision: 1, kind: "file", title: "Player file", description: "", body: "", attachments: [asset], audience: { kind: "room" }, locked: false, archived: false, extensions: {} } } });
    expect(new TextDecoder().decode(hostBytes)).toBe("player-owned attachment");
    expect(host.world.artifacts.has("player-upload-artifact")).toBe(true);
    const readsAfterUpload = aliceReads;
    await alice.submitConfirmed({ type: "artifact.upserted", audience: { kind: "room" }, payload: { artifact: { ...host.world.artifacts.get("player-upload-artifact")!, revision: 2, title: "Player file edited" } } });
    expect(aliceReads).toBe(readsAfterUpload);
    await eventually(() => bob.world.artifacts.has("player-upload-artifact"));
    bob.requestAssetFromHost(asset);
    await eventually(() => bobReceived.length > 0);
    expect(bobReceived).toBe("player-owned attachment");
    alice.stop(); bob.stop(); host.stop();
  });

  it("rejects a player attachment whose bytes fail the exact descriptor without sequencing an event", async () => {
    const hub = new MemoryTransportHub();
    const hostRoom = roomRecord("host-bad-upload-v2", "host", "seat-host");
    const host = new RoomSessionV2({ room: hostRoom, displayName: "KP", repository: new MemoryRepository(), transport: hub.create(participant(hostRoom, "KP"), hostRoom.hostPeerId) });
    await host.start();
    const invite = await host.issueSeatInvitation("Alice", "seat-bad-upload");
    await saveLocalSeatSecret(hostRoom.id, invite.seatId, invite.seatSecret);
    const aliceRoom = playerRoom(invite, "bad-upload-peer");
    const alice = new RoomSessionV2({ room: aliceRoom, displayName: "Alice", repository: new MemoryRepository(), transport: hub.create(participant(aliceRoom, "Alice"), hostRoom.hostPeerId) });
    await alice.start(); await eventually(() => alice.isAuthenticated);
    const expected = new TextEncoder().encode("expected bytes");
    const corrupted = new TextEncoder().encode("corruptd bytes");
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", expected)), (value) => value.toString(16).padStart(2, "0")).join("");
    const asset = { schemaVersion: 1 as const, assetId: `sha256:${hash}` as const, mediaType: "audio/mpeg", byteLength: expected.byteLength };
    host.enableAssetTransfers({ hasLocalAsset: async () => false, readLocalChunk: async () => new Uint8Array(), finalizeReceivedAsset: async () => { throw new Error("hash failure must precede finalize"); } });
    alice.enableAssetTransfers({ readLocalChunk: async ({ offset, length }) => corrupted.slice(offset, offset + length), finalizeReceivedAsset: async () => undefined, hasLocalAsset: async () => true });
    await expect(alice.submitConfirmed({ type: "artifact.upserted", audience: { kind: "room" }, payload: { artifact: { schemaVersion: 2, artifactId: "bad-player-upload", revision: 1, kind: "file", title: "Bad", description: "", body: "", attachments: [asset], audience: { kind: "room" }, locked: false, archived: false, extensions: {} } } })).rejects.toThrow();
    expect(host.world.artifacts.has("bad-player-upload")).toBe(false);
    expect(host.lastContiguousSequence).toBe(0);
    hub.deliver(hostRoom.hostPeerId, aliceRoom.localPeerId, { kind: "asset.request", transferId: "post-command-abuse", asset });
    await eventually(() => hub.messages.some(({ from, to, message }) => from === aliceRoom.localPeerId && to === hostRoom.hostPeerId && message.kind === "asset.error" && message.transferId === "post-command-abuse"));
    expect(hub.messages.some(({ message }) => message.kind === "asset.error" && message.transferId === "post-command-abuse" && message.code === "FORBIDDEN")).toBe(true);
    alice.stop(); host.stop();
  });

  it("waits for authoritative confirmation and exposes revision conflicts to editors", async () => {
    const hub = new MemoryTransportHub();
    const hostRoom = roomRecord("host-peer-v2", "host", "seat-host");
    const host = new RoomSessionV2({
      room: hostRoom,
      displayName: "KP",
      repository: new MemoryRepository(),
      transport: hub.create(participant(hostRoom, "KP"), hostRoom.hostPeerId),
    });
    await host.start();
    const invitation = await host.issueSeatInvitation("Alice", "seat-confirmed-alice");
    await saveLocalSeatSecret(invitation.roomId, invitation.seatId, invitation.seatSecret);
    const aliceRoom = playerRoom(invitation, "confirmed-alice-peer");
    const alice = new RoomSessionV2({
      room: aliceRoom,
      displayName: "Alice",
      repository: new MemoryRepository(),
      transport: hub.create(participant(aliceRoom, "Alice"), hostRoom.hostPeerId),
    });
    await alice.start();
    await eventually(() => alice.isAuthenticated);

    const artifact = {
      schemaVersion: 2 as const,
      artifactId: "artifact-confirmed-edit",
      revision: 1,
      kind: "clue" as const,
      title: "初始标题",
      description: "",
      body: "初始正文",
      attachments: [],
      audience: { kind: "room" as const },
      locked: false,
      archived: false,
      extensions: {},
    };
    await host.submit({ type: "artifact.upserted", audience: artifact.audience, payload: { artifact } });
    await eventually(() => alice.world.artifacts.get(artifact.artifactId)?.revision === 1);

    await host.submit({
      type: "artifact.upserted",
      audience: artifact.audience,
      payload: { artifact: { ...artifact, revision: 2, body: "KP 已保存的正文" } },
    });
    await eventually(() => alice.world.artifacts.get(artifact.artifactId)?.revision === 2);

    const rejected = alice.submitConfirmed({
      type: "artifact.upserted",
      audience: artifact.audience,
      payload: { artifact: { ...artifact, revision: 2, body: "Alice 的并发正文" } },
    });
    await expect(rejected).rejects.toMatchObject({
      name: "RoomCommandRejectedError",
      code: "CONFLICT",
    } satisfies Partial<RoomCommandRejectedError>);

    alice.stop();
    host.stop();
  });

  it("returns FORBIDDEN for paused or closed NPC panels and requires a new session after close", async () => {
    const hub = new MemoryTransportHub();
    const hostRoom = roomRecord("host-peer-v2", "host", "seat-host");
    const host = new RoomSessionV2({
      room: hostRoom,
      displayName: "KP",
      repository: new MemoryRepository(),
      transport: hub.create(participant(hostRoom, "KP"), hostRoom.hostPeerId),
    });
    await host.start();
    const invitation = await host.issueSeatInvitation("Alice", "seat-npc-alice");
    await saveLocalSeatSecret(invitation.roomId, invitation.seatId, invitation.seatSecret);
    const aliceRoom = playerRoom(invitation, "npc-alice-peer");
    const alice = new RoomSessionV2({
      room: aliceRoom,
      displayName: "Alice",
      repository: new MemoryRepository(),
      transport: hub.create(participant(aliceRoom, "Alice"), hostRoom.hostPeerId),
    });
    await alice.start();
    await eventually(() => alice.isAuthenticated);

    const audience = { kind: "seats" as const, seatIds: [invitation.seatId] };
    const npc = {
      schemaVersion: 2 as const,
      entityId: "npc-doorkeeper-lifecycle",
      revision: 1,
      kind: "npc" as const,
      name: "守门人",
      description: "脸色苍白。",
      artifactIds: [],
      audience: { kind: "room" as const },
      data: {},
      extensions: {},
    };
    const active = {
      schemaVersion: 1 as const,
      sessionId: "npc-session-lifecycle",
      revision: 1,
      npcEntityId: npc.entityId,
      title: "与守门人交谈",
      description: "定向交谈",
      status: "active" as const,
      audience,
      provider: "codex" as const,
      model: "",
      autoReply: false,
      mode: "shadow" as const,
      pinnedContext: [],
      startedAt: "2026-08-29T12:00:00.000Z",
      extensions: {},
    };
    await host.submitConfirmed({ type: "entity.upserted", audience: npc.audience, payload: { entity: npc } });
    await host.submitConfirmed({ type: "npc.session.upserted", audience, payload: { session: active } });
    await eventually(() => alice.world.npcSessions.get(active.sessionId)?.status === "active");

    const paused = { ...active, revision: 2, status: "paused" as const };
    await host.submitConfirmed({ type: "npc.session.upserted", audience, payload: { session: paused } });
    await eventually(() => alice.world.npcSessions.get(active.sessionId)?.status === "paused");
    const sequenceWhilePaused = host.lastContiguousSequence;
    await expect(alice.submitConfirmed({
      type: "npc.session.message",
      audience,
      payload: { sessionId: active.sessionId, messageId: uuidFor(901), role: "human", speakerSeatId: invitation.seatId, spokenText: "暂停期间的问题" },
    })).rejects.toMatchObject({ name: "RoomCommandRejectedError", code: "FORBIDDEN" } satisfies Partial<RoomCommandRejectedError>);
    expect(host.lastContiguousSequence).toBe(sequenceWhilePaused);
    expect(host.world.npcMessages.get(active.sessionId)).toBeUndefined();

    const resumed = { ...paused, revision: 3, status: "active" as const };
    await host.submitConfirmed({ type: "npc.session.upserted", audience, payload: { session: resumed } });
    await alice.submitConfirmed({
      type: "npc.session.message",
      audience,
      payload: { sessionId: active.sessionId, messageId: uuidFor(902), role: "human", speakerSeatId: invitation.seatId, spokenText: "恢复后的问题" },
    });
    await eventually(() => host.world.npcMessages.get(active.sessionId)?.length === 1);

    const closed = {
      ...resumed,
      revision: 4,
      status: "closed" as const,
      autoReply: false,
      endedAt: "2026-08-29T12:05:00.000Z",
    };
    await host.submitConfirmed({ type: "npc.session.upserted", audience, payload: { session: closed } });
    await eventually(() => alice.world.npcSessions.get(active.sessionId)?.status === "closed");
    const sequenceAfterClose = host.lastContiguousSequence;
    await expect(alice.submitConfirmed({
      type: "npc.session.message",
      audience,
      payload: { sessionId: active.sessionId, messageId: uuidFor(903), role: "human", speakerSeatId: invitation.seatId, spokenText: "结束后的问题" },
    })).rejects.toMatchObject({ name: "RoomCommandRejectedError", code: "FORBIDDEN" } satisfies Partial<RoomCommandRejectedError>);
    expect(host.lastContiguousSequence).toBe(sequenceAfterClose);
    expect(host.world.npcMessages.get(active.sessionId)).toHaveLength(1);

    await expect(host.submitConfirmed({
      type: "npc.session.upserted",
      audience,
      payload: { session: { ...resumed, revision: 5 } },
    })).rejects.toThrow(/closed NPC session .* cannot be updated/i);
    const replacement = { ...active, sessionId: "npc-session-replacement", title: "新的定向交谈" };
    await host.submitConfirmed({ type: "npc.session.upserted", audience, payload: { session: replacement } });
    await alice.submitConfirmed({
      type: "npc.session.message",
      audience,
      payload: { sessionId: replacement.sessionId, messageId: uuidFor(904), role: "human", speakerSeatId: invitation.seatId, spokenText: "新会话的问题" },
    });
    await eventually(() => host.world.npcMessages.get(replacement.sessionId)?.length === 1);
    expect(host.world.npcSessions.get(active.sessionId)?.status).toBe("closed");
    expect(host.world.npcSessions.get(replacement.sessionId)?.status).toBe("active");

    alice.stop();
    host.stop();
  });

  it("runs a complete KP/player investigation from map staging through an authorized check and shared clue", async () => {
    const hub = new MemoryTransportHub();
    const hostRepository = new MemoryRepository();
    const playerRepository = new MemoryRepository();
    const hostRoom = roomRecord("host-full-session", "host", "seat-host-full-session");
    const rngValues = [4, 2]; // 24 on 1d100
    const host = new RoomSessionV2({
      room: hostRoom,
      displayName: "KP",
      repository: hostRepository,
      transport: hub.create(participant(hostRoom, "KP"), hostRoom.hostPeerId),
      rng: () => rngValues.shift() ?? 0,
    });
    await host.start();
    const invitation = await host.issueSeatInvitation("记者玩家", "seat-investigator");
    await saveLocalSeatSecret(invitation.roomId, invitation.seatId, invitation.seatSecret);
    const joinedRoom = playerRoom(invitation, "peer-investigator");
    const player = new RoomSessionV2({
      room: joinedRoom,
      displayName: "记者玩家",
      repository: playerRepository,
      transport: hub.create(participant(joinedRoom, "记者玩家"), hostRoom.hostPeerId),
    });
    await player.start();
    await eventually(() => player.isAuthenticated);

    const roomAudience = { kind: "room" as const };
    const character = scenarioCharacter(invitation.seatId);
    await player.submitConfirmed({ type: "character.updated", audience: roomAudience, payload: { character } });
    await host.submitConfirmed({ type: "module.switched", audience: roomAudience, payload: { moduleId: "module-terminal-opus", revision: 1, title: "通往天国的终幕曲" } });
    const background = { schemaVersion: 1 as const, assetId: `sha256:${"b".repeat(64)}` as const, mediaType: "image/webp", byteLength: 1_024, width: 1_600, height: 900 };
    await host.submitConfirmed({ type: "artifact.upserted", audience: roomAudience, payload: { artifact: { schemaVersion: 2, artifactId: "artifact-map-background", revision: 1, kind: "map-background", title: "剧院地图", description: "", body: "", attachments: [], asset: background, audience: roomAudience, locked: true, archived: false, extensions: {} } } });
    await host.submitConfirmed({ type: "board.created", audience: roomAudience, payload: { board: { schemaVersion: 1, boardId: "board-theater-map", revision: 1, kind: "map", name: "终幕剧院", description: "", audience: roomAudience, logicalSize: { width: 1_600, height: 900 }, backgroundArtifactId: "artifact-map-background", archived: false, items: [], edges: [], extensions: {} } } });

    const scene = { schemaVersion: 2 as const, entityId: "scene-backstage", revision: 1, kind: "scene" as const, name: "后台唱片室", description: "", artifactIds: [], audience: roomAudience, data: { sourceRef: { moduleId: "module-terminal-opus", revision: 1, kind: "scene", id: "scene-source-backstage" } }, extensions: {} };
    const investigator = { schemaVersion: 2 as const, entityId: "entity-investigator", revision: 1, kind: "character" as const, name: character.name, description: character.occupation, artifactIds: [], audience: roomAudience, data: { characterId: character.id, ownerSeatId: invitation.seatId, roomRole: "character-token" }, extensions: {} };
    await host.submitConfirmed({ type: "entity.upserted", audience: roomAudience, payload: { entity: scene } });
    await host.submitConfirmed({ type: "board.item.upserted", audience: roomAudience, payload: { boardId: "board-theater-map", boardRevision: 2, item: boardEntityItem("item-scene", scene.entityId, scene.name, { x: 900, y: 430 }, true, { width: 420, height: 260 }) } });
    await host.submitConfirmed({ type: "entity.upserted", audience: roomAudience, payload: { entity: investigator } });
    await host.submitConfirmed({ type: "board.item.upserted", audience: roomAudience, payload: { boardId: "board-theater-map", boardRevision: 3, item: boardEntityItem("item-investigator", investigator.entityId, investigator.name, { x: 180, y: 720 }, false, { width: 130, height: 130 }) } });
    await player.submitConfirmed({ type: "board.item.upserted", audience: roomAudience, payload: { boardId: "board-theater-map", boardRevision: 4, item: boardEntityItem("item-investigator", investigator.entityId, investigator.name, { x: 900, y: 430 }, false, { width: 130, height: 130 }) } });

    await host.submitConfirmed({ type: "entity.upserted", audience: roomAudience, payload: { entity: { schemaVersion: 2, entityId: "location-record-room", revision: 1, kind: "location", name: "后台唱片室", description: "积灰的唱片机仍在缓慢旋转，墙上贴着褪色的演出表。", artifactIds: [], audience: roomAudience, data: { sourceRef: { moduleId: "module-terminal-opus", revision: 1, kind: "location", id: "location-source-record-room" } }, extensions: {} } } });
    const npc = { schemaVersion: 2 as const, entityId: "npc-stagehand", revision: 1, kind: "npc" as const, name: "年迈场务", description: "一名不愿直视唱片机的老场务。", artifactIds: [], audience: roomAudience, data: { sourceRef: { moduleId: "module-terminal-opus", revision: 1, kind: "npc", id: "npc-source-stagehand" } }, extensions: {} };
    await host.submitConfirmed({ type: "entity.upserted", audience: roomAudience, payload: { entity: npc } });
    await host.submitConfirmed({ type: "board.item.upserted", audience: roomAudience, payload: { boardId: "board-theater-map", boardRevision: 5, item: boardEntityItem("item-stagehand", npc.entityId, npc.name, { x: 1_020, y: 510 }, false, { width: 150, height: 150 }) } });

    await player.submitConfirmed({ type: "check.requested", audience: roomAudience, payload: { requestId: "check-spot-hidden", characterId: character.id, characterName: character.name, skillName: "侦查", proposedTarget: 60, reason: "检查唱片机内部是否藏有夹层" } });
    await host.submitConfirmed({ type: "check.authorized", audience: roomAudience, payload: { requestId: "check-spot-hidden", target: 60, requiredDifficulty: "regular", bonusDice: 0, penaltyDice: 0, note: "可以，进行一次普通侦查检定。" } });
    await player.rollDice({ expression: "1d100", reason: "侦查：检查唱片机夹层", bonusDice: 0, penaltyDice: 0, target: 60, requiredDifficulty: "regular", checkRequestId: "check-spot-hidden" });
    await eventually(() => host.world.checkAuthorizations.get("check-spot-hidden")?.resolvedByEventId !== undefined);
    await host.submitConfirmed({ type: "chat.message", audience: roomAudience, payload: { message: "你拆下唱针底座，发现一张写有倒放曲序的便笺。", format: "plain" } });
    await host.submitConfirmed({ type: "artifact.upserted", audience: roomAudience, payload: { artifact: { schemaVersion: 2, artifactId: "clue-reversed-score", revision: 1, kind: "clue", title: "倒放的曲序", description: "唱片机夹层中的便笺", body: "曲目必须从终幕向序曲倒放。", attachments: [], audience: roomAudience, locked: true, archived: false, extensions: { sourceRef: { moduleId: "module-terminal-opus", revision: 1, kind: "clue", id: "clue-source-reversed-score" } } } } });
    await player.submitConfirmed({ type: "clue.claimed", audience: roomAudience, payload: { artifactId: "clue-reversed-score", characterId: character.id, characterName: character.name } });
    await host.submitConfirmed({ type: "board.created", audience: roomAudience, payload: { board: { schemaVersion: 1, boardId: "board-public-clues", revision: 1, kind: "evidence", name: "公开线索板", description: "", audience: roomAudience, logicalSize: { width: 1_600, height: 900 }, archived: false, items: [], edges: [], extensions: {} } } });
    await host.submitConfirmed({ type: "board.item.upserted", audience: roomAudience, payload: { boardId: "board-public-clues", boardRevision: 2, item: { schemaVersion: 1, itemId: "item-reversed-score", reference: { kind: "artifact", artifactId: "clue-reversed-score" }, label: "倒放的曲序", position: { x: 400, y: 280 }, size: { width: 310, height: 180 }, rotationDegrees: 0, scale: 1, zIndex: 0, locked: false, audience: roomAudience, extensions: { roomRole: "clue-card" } } } });

    await eventually(() => player.lastContiguousSequence === host.lastContiguousSequence);
    const playerViews = await playerRepository.listEventViewsV2(hostRoom.id);
    expect(playerViews.every(({ view }) => view === "full")).toBe(true);
    expect(player.world.boards.get("board-theater-map")?.items.find(({ itemId }) => itemId === "item-investigator")?.position).toEqual({ x: 900, y: 430 });
    expect(player.world.entities.get("location-record-room")?.description).toContain("唱片机");
    expect(player.world.entities.get("npc-stagehand")?.description).toContain("老场务");
    const roll = playerViews.flatMap((view) => view.view === "full" && view.event.type === "dice.result" ? [view.event] : [])[0];
    expect(roll?.payload.result).toMatchObject({ total: 24, check: { success: true, target: 60 } });
    expect(player.world.clueClaims.get("clue-reversed-score")?.map(({ characterName }) => characterName)).toEqual([character.name]);
    expect(player.world.boards.get("board-public-clues")?.items[0]?.reference).toEqual({ kind: "artifact", artifactId: "clue-reversed-score" });
    expect(JSON.stringify(playerViews)).not.toContain("keeperNotes");

    player.stop();
    host.stop();
  });
});

function roomRecord(peerId: string, role: "host" | "player", seatId: string): RoomRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "room_v2_integration",
    name: "V2 integration",
    localRole: role,
    localPeerId: peerId,
    hostPeerId: role === "host" ? peerId : "host-peer-v2",
    inviteToken: role === "host" ? "host-token-12345678901234567890" : "join-token-12345678901234567890",
    ...(role === "host" ? { joinToken: "join-token-12345678901234567890" } : {}),
    relayUrl: "wss://relay.example.test/v1/rooms/ws",
    lastSeq: 0,
    createdAt: now,
    updatedAt: now,
    protocolVersion: 2,
    localSeatId: seatId,
    hostSeatId: role === "host" ? seatId : "seat-host",
    seatCredentialVersion: 1,
  };
}

function playerRoom(
  invitation: Awaited<ReturnType<RoomSessionV2["issueSeatInvitation"]>>,
  peerId: string,
): RoomRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: invitation.roomId,
    name: "Joined V2 room",
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
  return {
    peerId: room.localPeerId,
    displayName,
    role: room.localRole,
  };
}

async function eventually(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}

function uuidFor(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function scenarioCharacter(ownerSeatId: string): Coc7Character {
  return {
    schemaVersion: 1,
    id: "character-reporter",
    ownerPeerId: ownerSeatId,
    name: "林默",
    playerName: "记者玩家",
    occupation: "调查记者",
    age: 29,
    residence: "东京",
    birthplace: "横滨",
    characteristics: { str: 45, con: 55, siz: 50, dex: 60, app: 55, int: 70, pow: 60, edu: 65, luck: 50 },
    derived: { hitPoints: 10, maxHitPoints: 10, magicPoints: 12, maxMagicPoints: 12, sanity: 60, maxSanity: 99, movementRate: 8, build: 0, damageBonus: "0" },
    skills: [{ id: "skill-spot-hidden", name: "侦查", baseValue: 25, value: 60, checked: false }],
    status: { temporaryInsanity: false, indefiniteInsanity: false, majorWound: false, dying: false, unconscious: false },
    inventory: [],
    background: { personalDescription: "", ideologyAndBeliefs: "", significantPeople: "", meaningfulLocations: "", treasuredPossessions: "", traits: "", injuriesAndScars: "", phobiasAndManias: "", arcaneTomesSpellsAndArtifacts: "", encountersWithStrangeEntities: "" },
    notes: "",
    updatedAt: "2026-08-29T00:00:00.000Z",
    extensions: {},
  };
}

function boardEntityItem(
  itemId: string,
  entityId: string,
  label: string,
  position: { x: number; y: number },
  locked: boolean,
  size: { width: number; height: number },
) {
  return {
    schemaVersion: 1 as const,
    itemId,
    reference: { kind: "entity" as const, entityId },
    label,
    position,
    size,
    rotationDegrees: 0,
    scale: 1,
    zIndex: 0,
    locked,
    audience: { kind: "room" as const },
    extensions: {},
  };
}
