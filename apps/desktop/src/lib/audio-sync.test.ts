import type { AssetDescriptorV1, RoomEventV2 } from "@coc-room/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SynchronizedAudioRuntime,
  type AudioCuePayloadV2,
  type AudioPlaybackHandle,
  type AudioSyncStatus,
} from "./audio-sync";

class FakeAudio implements AudioPlaybackHandle {
  currentTime = 0;
  loop = false;
  volume = 1;
  readonly pause = vi.fn();
  readonly play: ReturnType<typeof vi.fn<() => Promise<void>>>;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(play: () => Promise<void> = async () => undefined) {
    this.play = vi.fn(play);
  }

  addEventListener(type: "ended" | "error", listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: "ended" | "error", listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: "ended" | "error"): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

const ASSET_A: AssetDescriptorV1 = {
  schemaVersion: 1,
  assetId: `sha256:${"a".repeat(64)}`,
  mediaType: "audio/ogg",
  byteLength: 1_024,
  durationMs: 20_000,
};

const ASSET_B: AssetDescriptorV1 = {
  ...ASSET_A,
  assetId: `sha256:${"b".repeat(64)}`,
};

function cue(overrides: Partial<AudioCuePayloadV2> = {}): AudioCuePayloadV2 {
  return {
    cueId: "ambience",
    asset: ASSET_A,
    loop: true,
    volume: 0.8,
    fadeInMs: 0,
    startOffsetMs: 0,
    ...overrides,
  };
}

describe("SynchronizedAudioRuntime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies loop, offset, fade-in, baseline volume, and local controls", async () => {
    const statuses: AudioSyncStatus[] = [];
    const audio = new FakeAudio();
    const runtime = new SynchronizedAudioRuntime({
      resolveAssetUrl: async () => "asset://ambience",
      createAudio: () => audio,
      localVolume: 0.5,
      fadeTickMs: 50,
      onStatus: (status) => statuses.push(status),
    });

    expect(runtime.consumeCue(cue({ fadeInMs: 1_000, startOffsetMs: 3_500 }), {
      eventId: "cue-1",
      sequence: 10,
    })).toBe(true);
    expect(statuses.at(-1)?.status).toBe("waiting");

    await runtime.whenIdle();
    expect(audio.loop).toBe(true);
    expect(audio.currentTime).toBe(3.5);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(audio.volume).toBe(0);
    expect(statuses.at(-1)?.status).toBe("playing");

    await vi.advanceTimersByTimeAsync(500);
    expect(audio.volume).toBeCloseTo(0.2);
    await vi.advanceTimersByTimeAsync(500);
    expect(audio.volume).toBeCloseTo(0.4);

    runtime.setMuted(true);
    expect(audio.volume).toBe(0);
    runtime.setMuted(false);
    runtime.setLocalVolume(0.25);
    expect(audio.volume).toBeCloseTo(0.2);
  });

  it("fades out without delaying event consumption", async () => {
    const statuses: AudioSyncStatus[] = [];
    const audio = new FakeAudio();
    const runtime = new SynchronizedAudioRuntime({
      resolveAssetUrl: async () => "asset://rain",
      createAudio: () => audio,
      onStatus: (status) => statuses.push(status),
    });
    runtime.consumeCue(cue({ volume: 0.6 }), { eventId: "start", sequence: 1 });
    await runtime.whenIdle();

    expect(runtime.consumeStopped({ cueId: "ambience", fadeOutMs: 1_000 }, {
      eventId: "stop",
      sequence: 2,
    })).toBe(true);
    expect(audio.pause).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(audio.volume).toBeCloseTo(0.3);
    expect(audio.pause).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(audio.volume).toBe(0);
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(statuses.at(-1)).toMatchObject({
      status: "stopped",
      cueId: "ambience",
      reason: "event",
      eventId: "stop",
    });
  });

  it("replaces a playing cue with the same cue id and releases its URL", async () => {
    const audios = [new FakeAudio(), new FakeAudio()];
    const released: string[] = [];
    const statuses: AudioSyncStatus[] = [];
    const runtime = new SynchronizedAudioRuntime({
      resolveAssetUrl: async (asset) => asset.assetId === ASSET_A.assetId ? "asset://a" : "asset://b",
      createAudio: () => audios.shift()!,
      releaseAssetUrl: (url) => released.push(url),
      onStatus: (status) => statuses.push(status),
    });
    const firstAudio = audios[0]!;
    const secondAudio = audios[1]!;

    runtime.consumeCue(cue(), { eventId: "first", sequence: 1 });
    await runtime.whenIdle();
    runtime.consumeCue(cue({ asset: ASSET_B, volume: 0.4 }), {
      eventId: "second",
      sequence: 2,
    });
    await runtime.whenIdle();

    expect(firstAudio.pause).toHaveBeenCalledOnce();
    expect(secondAudio.play).toHaveBeenCalledOnce();
    expect(secondAudio.volume).toBeCloseTo(0.4);
    expect(released).toContain("asset://a");
    expect(statuses).toContainEqual(expect.objectContaining({
      status: "stopped",
      reason: "replaced",
      eventId: "first",
    }));
  });

  it("cancels a waiting cue and never creates its late audio", async () => {
    let resolveFirst!: (url: string) => void;
    const firstResolution = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const createAudio = vi.fn(() => new FakeAudio());
    const released: string[] = [];
    const statuses: AudioSyncStatus[] = [];
    const runtime = new SynchronizedAudioRuntime({
      resolveAssetUrl: vi.fn()
        .mockImplementationOnce(() => firstResolution)
        .mockResolvedValueOnce("asset://new"),
      createAudio,
      releaseAssetUrl: (url) => released.push(url),
      onStatus: (status) => statuses.push(status),
    });

    runtime.consumeCue(cue(), { eventId: "slow", sequence: 1 });
    runtime.consumeCue(cue({ asset: ASSET_B }), { eventId: "fast", sequence: 2 });
    await Promise.resolve();
    await Promise.resolve();
    expect(createAudio).toHaveBeenCalledOnce();
    expect(statuses).toContainEqual(expect.objectContaining({
      status: "skipped",
      reason: "superseded",
      eventId: "slow",
    }));

    resolveFirst("asset://old");
    await runtime.whenIdle();
    expect(createAudio).toHaveBeenCalledOnce();
    expect(released).toContain("asset://old");
  });

  it("deduplicates event ids or sequences and rejects stale per-cue replay", async () => {
    const statuses: AudioSyncStatus[] = [];
    const createAudio = vi.fn(() => new FakeAudio());
    const runtime = new SynchronizedAudioRuntime({
      resolveAssetUrl: async () => "asset://tone",
      createAudio,
      onStatus: (status) => statuses.push(status),
    });

    expect(runtime.consumeCue(cue(), { eventId: "event-10", sequence: 10 })).toBe(true);
    await runtime.whenIdle();
    expect(runtime.consumeCue(cue(), { eventId: "event-10", sequence: 11 })).toBe(false);
    expect(runtime.consumeCue(cue(), { eventId: "different", sequence: 10 })).toBe(false);
    expect(runtime.consumeStopped({ cueId: "ambience", fadeOutMs: 0 }, {
      eventId: "event-12",
      sequence: 12,
    })).toBe(true);
    expect(runtime.consumeCue(cue(), { eventId: "event-11", sequence: 11 })).toBe(false);

    expect(createAudio).toHaveBeenCalledOnce();
    expect(statuses.flatMap((status) => status.status === "skipped" ? [status.reason] : []))
      .toEqual(["duplicate", "duplicate", "stale"]);
  });

  it("reports unavailable, resolver, and play failures without rejecting", async () => {
    const statuses: AudioSyncStatus[] = [];
    const unavailable = new SynchronizedAudioRuntime({
      resolveAssetUrl: async () => undefined,
      onStatus: (status) => statuses.push(status),
    });
    unavailable.consumeCue(cue({ cueId: "missing" }));
    await unavailable.whenIdle();

    const resolverFailure = new SynchronizedAudioRuntime({
      resolveAssetUrl: async () => { throw new Error("offline"); },
      onStatus: (status) => statuses.push(status),
    });
    resolverFailure.consumeCue(cue({ cueId: "resolver-error" }));
    await resolverFailure.whenIdle();

    const playFailure = new SynchronizedAudioRuntime({
      resolveAssetUrl: async () => "asset://blocked",
      createAudio: () => new FakeAudio(async () => { throw new Error("autoplay blocked"); }),
      onStatus: (status) => statuses.push(status),
    });
    playFailure.consumeCue(cue({ cueId: "play-error" }));
    await playFailure.whenIdle();

    expect(statuses).toContainEqual(expect.objectContaining({
      status: "skipped",
      cueId: "missing",
      reason: "asset-unavailable",
    }));
    expect(statuses).toContainEqual(expect.objectContaining({
      status: "error",
      cueId: "resolver-error",
      phase: "resolve",
      message: "offline",
    }));
    expect(statuses).toContainEqual(expect.objectContaining({
      status: "error",
      cueId: "play-error",
      phase: "play",
      message: "autoplay blocked",
    }));
  });

  it("consumes confirmed V2 events, handles natural end, and disposes idempotently", async () => {
    const audio = new FakeAudio();
    const statuses: AudioSyncStatus[] = [];
    const runtime = new SynchronizedAudioRuntime({
      resolveAssetUrl: async () => "asset://confirmed",
      createAudio: () => audio,
      onStatus: (status) => statuses.push(status),
    });
    const event: Extract<RoomEventV2, { type: "audio.cued" }> = {
      protocolVersion: 2,
      roomId: "room_abcdefghijklmnop",
      eventId: "00000000-0000-4000-8000-000000000001",
      sequence: 1,
      sender: {
        seatId: "keeper",
        role: "host",
        displayName: "KP",
        extensions: {},
      },
      occurredAt: "2026-08-29T00:00:00.000Z",
      audience: { kind: "room" },
      type: "audio.cued",
      payload: cue(),
    };

    expect(runtime.consume(event)).toBe(true);
    await runtime.whenIdle();
    audio.dispatch("ended");
    expect(statuses.at(-1)).toMatchObject({ status: "stopped", reason: "ended" });

    runtime.consumeCue(cue({ cueId: "second" }), { eventId: "second", sequence: 2 });
    await runtime.whenIdle();
    runtime.dispose();
    runtime.dispose();
    expect(runtime.consumeCue(cue({ cueId: "after-dispose" }), {
      eventId: "third",
      sequence: 3,
    })).toBe(false);
    expect(statuses.at(-1)).toMatchObject({
      status: "skipped",
      cueId: "after-dispose",
      reason: "disposed",
    });
  });
});
