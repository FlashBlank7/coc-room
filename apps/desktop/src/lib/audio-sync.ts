import type {
  AssetDescriptorV1,
  RoomEventV2,
  RoomEventViewV2,
} from "@coc-room/protocol";

export type AudioCuePayloadV2 = Extract<
  RoomEventV2,
  { type: "audio.cued" }
>["payload"];

export type AudioStoppedPayloadV2 = Extract<
  RoomEventV2,
  { type: "audio.stopped" }
>["payload"];

export interface AudioEventIdentity {
  readonly eventId?: string;
  readonly sequence?: number;
}

/** The small subset of HTMLAudioElement used by the synchronized player. */
export interface AudioPlaybackHandle {
  currentTime: number;
  loop: boolean;
  volume: number;
  play(): void | Promise<void>;
  pause(): void;
  addEventListener?(type: "ended" | "error", listener: () => void): void;
  removeEventListener?(type: "ended" | "error", listener: () => void): void;
}

export type ResolveAudioAssetUrl = (
  asset: AssetDescriptorV1,
) => Promise<string | null | undefined>;

export type CreateAudioPlayback = (url: string) => AudioPlaybackHandle;

interface AudioStatusBase extends AudioEventIdentity {
  readonly cueId: string;
}

export type AudioSyncStatus =
  | (AudioStatusBase & {
      readonly status: "waiting";
      readonly asset: AssetDescriptorV1;
    })
  | (AudioStatusBase & {
      readonly status: "playing";
      readonly asset: AssetDescriptorV1;
      readonly loop: boolean;
    })
  | (AudioStatusBase & {
      readonly status: "skipped";
      readonly reason:
        | "asset-unavailable"
        | "duplicate"
        | "stale"
        | "superseded"
        | "disposed";
    })
  | (AudioStatusBase & {
      readonly status: "stopped";
      readonly reason: "event" | "replaced" | "ended" | "disposed" | "not-playing";
    })
  | (AudioStatusBase & {
      readonly status: "error";
      readonly phase: "resolve" | "create" | "configure" | "play" | "playback";
      readonly message: string;
    });

export interface SynchronizedAudioRuntimeOptions {
  readonly resolveAssetUrl: ResolveAudioAssetUrl;
  readonly createAudio?: CreateAudioPlayback;
  /** Called after a resolved URL is no longer used. Useful for object URLs. */
  readonly releaseAssetUrl?: (url: string, asset: AssetDescriptorV1) => void;
  readonly onStatus?: (status: AudioSyncStatus) => void;
  readonly localVolume?: number;
  readonly muted?: boolean;
  readonly fadeTickMs?: number;
  /** Injectable only to make fade progress deterministic in tests. */
  readonly now?: () => number;
}

interface CueSlot {
  readonly generation: number;
  readonly payload: AudioCuePayloadV2;
  readonly identity: AudioEventIdentity;
  url?: string;
  urlReleased: boolean;
  audio?: AudioPlaybackHandle;
  hasPlayed: boolean;
  canceled: boolean;
  gain: number;
  fadeTimer?: ReturnType<typeof setInterval>;
  readonly onEnded: () => void;
  readonly onError: () => void;
}

const DEFAULT_FADE_TICK_MS = 50;

/**
 * Applies confirmed semantic audio events to local-only playback.
 *
 * Asset resolution and `play()` happen in detached tasks: `consume*` never waits
 * for downloads, autoplay permission, or a provider failure. Callers can use
 * `whenIdle()` in tests or when they explicitly want to observe task completion.
 */
export class SynchronizedAudioRuntime {
  private readonly resolveAssetUrl: ResolveAudioAssetUrl;
  private readonly createAudio: CreateAudioPlayback;
  private readonly releaseAssetUrl?: (url: string, asset: AssetDescriptorV1) => void;
  private readonly onStatus?: (status: AudioSyncStatus) => void;
  private readonly fadeTickMs: number;
  private readonly now: () => number;
  private readonly cues = new Map<string, CueSlot>();
  private readonly pending = new Set<Promise<void>>();
  private readonly seenEventIds = new Set<string>();
  private readonly seenSequences = new Set<number>();
  private readonly latestSequenceByCue = new Map<string, number>();
  private generation = 0;
  private localVolume: number;
  private muted: boolean;
  private disposed = false;

  constructor(options: SynchronizedAudioRuntimeOptions) {
    this.resolveAssetUrl = options.resolveAssetUrl;
    this.createAudio = options.createAudio ?? createBrowserAudioPlayback;
    this.releaseAssetUrl = options.releaseAssetUrl;
    this.onStatus = options.onStatus;
    this.localVolume = clampUnit(options.localVolume ?? 1);
    this.muted = options.muted ?? false;
    this.fadeTickMs = Math.max(10, Math.floor(options.fadeTickMs ?? DEFAULT_FADE_TICK_MS));
    this.now = options.now ?? Date.now;
  }

  /** Consumes an event stream and ignores unrelated or redacted events. */
  consume(event: RoomEventV2): boolean {
    if (event.type === "audio.cued") {
      return this.consumeCue(event.payload, event);
    }
    if (event.type === "audio.stopped") {
      return this.consumeStopped(event.payload, event);
    }
    return false;
  }

  consumeView(view: RoomEventViewV2): boolean {
    return view.view === "full" ? this.consume(view.event) : false;
  }

  consumeCue(payload: AudioCuePayloadV2, identity: AudioEventIdentity = {}): boolean {
    const rejection = this.registerEvent(payload.cueId, identity);
    if (rejection !== undefined) {
      this.emit({ status: "skipped", cueId: payload.cueId, reason: rejection, ...identity });
      return false;
    }

    const previous = this.cues.get(payload.cueId);
    if (previous !== undefined) {
      this.supersede(previous);
    }

    const slot: CueSlot = {
      generation: ++this.generation,
      payload,
      identity,
      urlReleased: false,
      hasPlayed: false,
      canceled: false,
      gain: payload.fadeInMs > 0 ? 0 : 1,
      onEnded: () => this.finishNaturally(slot),
      onError: () => this.failSlot(slot, "playback", "The audio element reported a playback error."),
    };
    this.cues.set(payload.cueId, slot);
    this.emit({
      status: "waiting",
      cueId: payload.cueId,
      asset: payload.asset,
      ...identity,
    });

    this.track(this.startCue(slot));
    return true;
  }

  consumeStopped(
    payload: AudioStoppedPayloadV2,
    identity: AudioEventIdentity = {},
  ): boolean {
    const rejection = this.registerEvent(payload.cueId, identity);
    if (rejection !== undefined) {
      this.emit({ status: "skipped", cueId: payload.cueId, reason: rejection, ...identity });
      return false;
    }

    const slot = this.cues.get(payload.cueId);
    if (slot === undefined) {
      this.emit({
        status: "stopped",
        cueId: payload.cueId,
        reason: "not-playing",
        ...identity,
      });
      return true;
    }

    slot.canceled = true;
    this.clearFade(slot);
    if (slot.audio === undefined || !slot.hasPlayed || payload.fadeOutMs === 0) {
      this.cleanupSlot(slot, true);
      this.emit({ status: "stopped", cueId: payload.cueId, reason: "event", ...identity });
      return true;
    }

    // Keep this slot current while it fades, but prevent its async start path
    // from emitting a late "playing" transition.
    const initialGain = slot.gain;
    const startedAt = this.now();
    slot.fadeTimer = setInterval(() => {
      if (!this.isCurrent(slot)) {
        this.clearFade(slot);
        return;
      }
      const progress = clampUnit((this.now() - startedAt) / payload.fadeOutMs);
      slot.gain = initialGain * (1 - progress);
      if (!this.writeVolume(slot)) {
        return;
      }
      if (progress >= 1) {
        this.cleanupSlot(slot, true);
        this.emit({ status: "stopped", cueId: payload.cueId, reason: "event", ...identity });
      }
    }, this.fadeTickMs);
    return true;
  }

  setLocalVolume(volume: number): void {
    this.localVolume = clampUnit(volume);
    this.refreshVolumes();
  }

  getLocalVolume(): number {
    return this.localVolume;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.refreshVolumes();
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Resolves after currently pending URL-resolution/play tasks settle. */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const slot of [...this.cues.values()]) {
      slot.canceled = true;
      this.cleanupSlot(slot, true);
      this.emit({
        status: "stopped",
        cueId: slot.payload.cueId,
        reason: "disposed",
        ...slot.identity,
      });
    }
    this.cues.clear();
  }

  private async startCue(slot: CueSlot): Promise<void> {
    let url: string | null | undefined;
    try {
      url = await this.resolveAssetUrl(slot.payload.asset);
    } catch (error) {
      if (this.isCurrent(slot)) {
        this.failSlot(slot, "resolve", errorMessage(error));
      }
      return;
    }

    if (!this.isCurrent(slot)) {
      if (url) {
        this.releaseUrlValue(url, slot.payload.asset);
      }
      return;
    }
    if (!url) {
      this.cues.delete(slot.payload.cueId);
      this.emit({
        status: "skipped",
        cueId: slot.payload.cueId,
        reason: "asset-unavailable",
        ...slot.identity,
      });
      return;
    }
    slot.url = url;

    let audio: AudioPlaybackHandle;
    try {
      audio = this.createAudio(url);
      slot.audio = audio;
      audio.loop = slot.payload.loop;
      audio.currentTime = slot.payload.startOffsetMs / 1_000;
      audio.addEventListener?.("ended", slot.onEnded);
      audio.addEventListener?.("error", slot.onError);
      if (!this.writeVolume(slot)) {
        return;
      }
    } catch (error) {
      if (this.isCurrent(slot)) {
        this.failSlot(slot, slot.audio === undefined ? "create" : "configure", errorMessage(error));
      }
      return;
    }

    try {
      await Promise.resolve(audio.play());
    } catch (error) {
      if (this.isCurrent(slot)) {
        this.failSlot(slot, "play", errorMessage(error));
      }
      return;
    }

    if (!this.isCurrent(slot) || slot.canceled) {
      // A stop/replacement may have paused the element while `play()` was
      // pending. Pause once more after it settles so a late autoplay grant
      // cannot resurrect a canceled cue.
      try {
        audio.pause();
      } catch {
        // Best-effort cleanup; the semantic stop is already confirmed.
      }
      this.cleanupDetachedSlot(slot);
      return;
    }
    slot.hasPlayed = true;
    this.emit({
      status: "playing",
      cueId: slot.payload.cueId,
      asset: slot.payload.asset,
      loop: slot.payload.loop,
      ...slot.identity,
    });
    if (slot.payload.fadeInMs > 0) {
      this.startFadeIn(slot);
    }
  }

  private startFadeIn(slot: CueSlot): void {
    const startedAt = this.now();
    slot.fadeTimer = setInterval(() => {
      if (!this.isCurrent(slot) || slot.canceled) {
        this.clearFade(slot);
        return;
      }
      slot.gain = clampUnit((this.now() - startedAt) / slot.payload.fadeInMs);
      if (!this.writeVolume(slot)) {
        return;
      }
      if (slot.gain >= 1) {
        this.clearFade(slot);
      }
    }, this.fadeTickMs);
  }

  private refreshVolumes(): void {
    for (const slot of this.cues.values()) {
      if (slot.audio !== undefined) {
        this.writeVolume(slot);
      }
    }
  }

  private writeVolume(slot: CueSlot): boolean {
    if (slot.audio === undefined) {
      return true;
    }
    try {
      slot.audio.volume = this.muted
        ? 0
        : clampUnit(slot.payload.volume) * this.localVolume * clampUnit(slot.gain);
      return true;
    } catch (error) {
      if (this.isCurrent(slot)) {
        this.failSlot(slot, "configure", errorMessage(error));
      }
      return false;
    }
  }

  private supersede(slot: CueSlot): void {
    slot.canceled = true;
    const wasPlaying = slot.hasPlayed;
    this.cleanupSlot(slot, true);
    if (wasPlaying) {
      this.emit({
        status: "stopped",
        cueId: slot.payload.cueId,
        reason: "replaced",
        ...slot.identity,
      });
    } else {
      this.emit({
        status: "skipped",
        cueId: slot.payload.cueId,
        reason: "superseded",
        ...slot.identity,
      });
    }
  }

  private finishNaturally(slot: CueSlot): void {
    if (!this.isCurrent(slot)) {
      return;
    }
    this.cleanupSlot(slot, false);
    this.emit({
      status: "stopped",
      cueId: slot.payload.cueId,
      reason: "ended",
      ...slot.identity,
    });
  }

  private failSlot(
    slot: CueSlot,
    phase: Extract<AudioSyncStatus, { status: "error" }>["phase"],
    message: string,
  ): void {
    if (!this.isCurrent(slot)) {
      return;
    }
    this.cleanupSlot(slot, true);
    this.emit({
      status: "error",
      cueId: slot.payload.cueId,
      phase,
      message,
      ...slot.identity,
    });
  }

  private cleanupSlot(slot: CueSlot, pause: boolean): void {
    if (this.cues.get(slot.payload.cueId) === slot) {
      this.cues.delete(slot.payload.cueId);
    }
    this.cleanupDetachedSlot(slot, pause);
  }

  private cleanupDetachedSlot(slot: CueSlot, pause = true): void {
    this.clearFade(slot);
    if (slot.audio !== undefined) {
      slot.audio.removeEventListener?.("ended", slot.onEnded);
      slot.audio.removeEventListener?.("error", slot.onError);
      if (pause) {
        try {
          slot.audio.pause();
        } catch {
          // Playback cleanup must never interrupt the confirmed event stream.
        }
      }
      slot.audio = undefined;
    }
    this.releaseSlotUrl(slot);
  }

  private clearFade(slot: CueSlot): void {
    if (slot.fadeTimer !== undefined) {
      clearInterval(slot.fadeTimer);
      slot.fadeTimer = undefined;
    }
  }

  private releaseSlotUrl(slot: CueSlot): void {
    if (slot.url === undefined || slot.urlReleased) {
      return;
    }
    slot.urlReleased = true;
    this.releaseUrlValue(slot.url, slot.payload.asset);
  }

  private releaseUrlValue(url: string, asset: AssetDescriptorV1): void {
    try {
      this.releaseAssetUrl?.(url, asset);
    } catch {
      // URL cleanup is best effort and must not affect room event processing.
    }
  }

  private isCurrent(slot: CueSlot): boolean {
    return !this.disposed && this.cues.get(slot.payload.cueId) === slot;
  }

  private registerEvent(
    cueId: string,
    identity: AudioEventIdentity,
  ): "duplicate" | "stale" | "disposed" | undefined {
    if (this.disposed) {
      return "disposed";
    }
    if (
      (identity.eventId !== undefined && this.seenEventIds.has(identity.eventId)) ||
      (identity.sequence !== undefined && this.seenSequences.has(identity.sequence))
    ) {
      return "duplicate";
    }

    if (identity.eventId !== undefined) {
      this.seenEventIds.add(identity.eventId);
    }
    if (identity.sequence !== undefined) {
      this.seenSequences.add(identity.sequence);
      const latest = this.latestSequenceByCue.get(cueId);
      if (latest !== undefined && identity.sequence < latest) {
        return "stale";
      }
      this.latestSequenceByCue.set(cueId, identity.sequence);
    }
    return undefined;
  }

  private track(task: Promise<void>): void {
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }

  private emit(status: AudioSyncStatus): void {
    try {
      this.onStatus?.(status);
    } catch {
      // UI observers are isolated from event and playback processing.
    }
  }
}

export function createBrowserAudioPlayback(url: string): AudioPlaybackHandle {
  return new Audio(url);
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
