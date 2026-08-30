import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { Coc7Character, ContentRevealedPayloadV1 } from "@coc-room/protocol";
import { DoorOpen, FileText, MapPin, Theater, UserRound, UsersRound } from "lucide-react";

import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";

/** Player-visible room data only. Keeper module entities must never be passed here. */
export interface PublishedRoomLocation {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/** Player-visible room data only. This intentionally excludes keeper NPC fields. */
export interface PublishedRoomNpc {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/** Minimal public presence shape. Never pass full character cards into the room stage. */
export interface RoomStageCharacter {
  readonly id: string;
  readonly ownerPeerId: string;
  readonly name: string;
  readonly occupation: string;
  readonly derived: Readonly<Pick<
    Coc7Character["derived"],
    "hitPoints" | "maxHitPoints" | "sanity"
  >>;
}

export interface RoomWorldStageProps {
  readonly locations: ReadonlyMap<string, PublishedRoomLocation>;
  readonly npcsByLocation: ReadonlyMap<string, ReadonlyMap<string, PublishedRoomNpc>>;
  readonly latestCharacters: ReadonlyMap<string, RoomStageCharacter>;
  readonly currentLocationByCharacterId: ReadonlyMap<string, string>;
  readonly locationContent?: ReadonlyMap<string, readonly ContentRevealedPayloadV1[]>;
  readonly localPeerId: string;
  readonly selectedLocationId?: string;
  readonly readOnly?: boolean;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly onSelectLocation?: (locationId: string) => void;
  readonly onEnterLocation?: (
    character: RoomStageCharacter,
    location: PublishedRoomLocation,
  ) => void;
}

export function RoomWorldStage({
  locations,
  npcsByLocation,
  latestCharacters,
  currentLocationByCharacterId,
  locationContent = EMPTY_LOCATION_CONTENT,
  localPeerId,
  selectedLocationId,
  readOnly = false,
  disabled = false,
  disabledReason,
  onSelectLocation,
  onEnterLocation,
}: RoomWorldStageProps) {
  const locationList = useMemo(() => [...locations.values()], [locations]);
  const characters = useMemo(() => [...latestCharacters.values()], [latestCharacters]);
  const ownCharacters = useMemo(
    () => characters.filter((character) => character.ownerPeerId === localPeerId),
    [characters, localPeerId],
  );
  const [uncontrolledLocationId, setUncontrolledLocationId] = useState<string>();
  const [selectedCharacterId, setSelectedCharacterId] = useState<string>();
  const selectedCharacter = ownCharacters.find((character) => character.id === selectedCharacterId)
    ?? ownCharacters[0];
  const ownCurrentLocationId = selectedCharacter
    ? currentLocationByCharacterId.get(selectedCharacter.id)
    : undefined;
  const availableLocationIds = useMemo(() => new Set(locations.keys()), [locations]);
  const activeLocationId = firstAvailableLocationId(
    availableLocationIds,
    selectedLocationId,
    uncontrolledLocationId,
    ownCurrentLocationId,
    locationList[0]?.id,
  );
  const activeLocation = activeLocationId ? locations.get(activeLocationId) : undefined;

  useEffect(() => {
    if (selectedCharacter && selectedCharacter.id !== selectedCharacterId) {
      setSelectedCharacterId(selectedCharacter.id);
    }
  }, [selectedCharacter, selectedCharacterId]);

  useEffect(() => {
    if (uncontrolledLocationId && !availableLocationIds.has(uncontrolledLocationId)) {
      setUncontrolledLocationId(undefined);
    }
  }, [availableLocationIds, uncontrolledLocationId]);

  if (locations.size === 0 || !activeLocation) {
    return (
      <section
        aria-label="房间地点舞台"
        className="grid max-h-[55vh] min-h-44 shrink-0 place-items-center overflow-y-auto border-b border-zinc-800 bg-zinc-950/65 px-6 py-10 text-center"
      >
        <div className="max-w-md">
          <MapPin className="mx-auto h-8 w-8 text-zinc-700" aria-hidden="true" />
          <h2 className="mt-3 font-serif text-xl text-zinc-300">还没有开放地点</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-500">
            {readOnly
              ? "这份本地记录中没有已公开地点。"
              : "KP 还没有向大家开放可进入的地点。此时仍可以继续聊天、行动和检定。"}
          </p>
        </div>
      </section>
    );
  }

  const presentCharacters = characters.filter(
    (character) => currentLocationByCharacterId.get(character.id) === activeLocation.id,
  );
  const presentNpcs = [...(npcsByLocation.get(activeLocation.id)?.values() ?? [])];
  const revealedContent = locationContent.get(activeLocation.id) ?? [];
  const alreadyHere = selectedCharacter
    ? currentLocationByCharacterId.get(selectedCharacter.id) === activeLocation.id
    : false;
  const ownCurrentLocation = ownCurrentLocationId ? locations.get(ownCurrentLocationId) : undefined;
  const entryDisabled = readOnly || disabled || !onEnterLocation || !selectedCharacter || alreadyHere;
  const entryLabel = readOnly
    ? "本地记录只读"
    : !selectedCharacter
      ? "先创建自己的调查员角色卡"
      : alreadyHere
        ? `${selectedCharacter.name} 已在${activeLocation.name}`
        : disabled
          ? disabledReason ?? "当前无法进入地点"
          : `${selectedCharacter.name}前往${activeLocation.name}`;
  const locationStatus = selectedCharacter
    ? alreadyHere
      ? `${selectedCharacter.name} 正在这里。`
      : ownCurrentLocation
        ? `${selectedCharacter.name} 目前在${ownCurrentLocation.name}；你正在查看${activeLocation.name}。`
        : `${selectedCharacter.name} 还没有进入任何地点；你正在查看${activeLocation.name}。`
    : `正在查看${activeLocation.name}。`;

  const selectLocation = (locationId: string) => {
    setUncontrolledLocationId(locationId);
    onSelectLocation?.(locationId);
  };

  return (
    <section aria-label="房间地点舞台" className="max-h-[55vh] shrink-0 overflow-y-auto border-b border-zinc-800 bg-zinc-950/70">
      <nav
        aria-label="已公开地点"
        className="sticky top-0 z-20 flex gap-2 overflow-x-auto border-b border-zinc-800 bg-zinc-950/95 px-5 py-3 backdrop-blur"
      >
        <span className="inline-flex shrink-0 items-center text-xs font-medium text-zinc-500">可前往：</span>
        {locationList.map((location) => {
          const selected = location.id === activeLocation.id;
          const ownCharacterHere = ownCharacters.some(
            (character) => currentLocationByCharacterId.get(character.id) === location.id,
          );
          return (
            <button
              key={location.id}
              type="button"
              aria-label={`查看地点：${location.name}`}
              aria-pressed={selected}
              onClick={() => selectLocation(location.id)}
              className={cn(
                "inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass/70",
                selected
                  ? "border-brass/70 bg-brass/15 text-amber-200"
                  : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200",
              )}
            >
              <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
              {location.name}
              {ownCharacterHere && (
                <span className="rounded-full bg-emerald-950 px-1.5 py-0.5 text-[10px] text-emerald-300">
                  你在这里
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div
        data-testid="location-backdrop"
        className="relative isolate overflow-hidden px-5 py-6"
        style={locationBackdrop(activeLocation.id)}
      >
        <div className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-black/5 via-zinc-950/35 to-zinc-950/95" />
        <div className="mx-auto grid max-w-5xl gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(260px,.65fr)]">
          <div className="rounded-xl border border-white/10 bg-zinc-950/70 p-5 shadow-2xl shadow-black/30 backdrop-blur-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-[.25em] text-brass">
                  <Theater className="h-3.5 w-3.5" aria-hidden="true" />{alreadyHere ? "当前所在地点" : "正在查看的地点"}
                </p>
                <h2 className="mt-2 font-serif text-3xl text-ink">{activeLocation.name}</h2>
              </div>
              {!readOnly && ownCharacters.length > 1 && (
                <label className="grid gap-1 text-xs text-zinc-400">
                  选择调查员
                  <select
                    aria-label="选择进入地点的调查员"
                    className="h-9 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-ink outline-none focus:border-brass"
                    value={selectedCharacter?.id ?? ""}
                    onChange={(event) => setSelectedCharacterId(event.target.value)}
                  >
                    {ownCharacters.map((character) => (
                      <option key={character.id} value={character.id}>{character.name}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-zinc-300">
              {activeLocation.description || "守秘人尚未提供这个地点的公开说明。"}
            </p>
            <p role="status" aria-live="polite" className={`mt-4 rounded-lg border px-3 py-2 text-xs leading-5 ${alreadyHere ? "border-emerald-900/60 bg-emerald-950/20 text-emerald-200" : "border-zinc-800 bg-zinc-950/60 text-zinc-400"}`}>
              {locationStatus}
            </p>
            {!readOnly && (
                <div className="mt-5 grid gap-2">
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    disabled={entryDisabled}
                    onClick={() => {
                      if (selectedCharacter) onEnterLocation?.(selectedCharacter, activeLocation);
                    }}
                  >
                    <DoorOpen className="mr-2 h-4 w-4" aria-hidden="true" />
                    {entryLabel}
                  </Button>
                  {disabled && disabledReason && (
                    <span className="text-xs text-amber-300">{disabledReason}</span>
                  )}
                  {!selectedCharacter && (
                    <span className="text-xs text-zinc-500">在角色卡页面保存自己的调查员后即可进入。</span>
                  )}
                </div>
                {!entryDisabled && selectedCharacter && (
                  <p className="text-xs leading-5 text-zinc-500">进入后，房间里的所有人都会看到{selectedCharacter.name}来到了{activeLocation.name}。</p>
                )}
              </div>
            )}
          </div>

          <div className="grid content-start gap-3">
            <PresencePanel
              title="在这里的调查员"
              icon={<UsersRound className="h-4 w-4" />}
              empty="目前没有调查员进入这里。"
            >
              {presentCharacters.map((character) => (
                <div key={character.id} className="rounded-lg border border-zinc-800 bg-zinc-950/65 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium text-zinc-100">{character.name}</div>
                      <div className="mt-0.5 text-[11px] text-zinc-500">{character.occupation || "调查员"}</div>
                    </div>
                    {character.ownerPeerId === localPeerId && (
                      <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] text-emerald-300">我的角色</span>
                    )}
                  </div>
                  <div className="mt-2 flex gap-3 font-mono text-[11px] text-zinc-400">
                    <span>HP {character.derived.hitPoints}/{character.derived.maxHitPoints}</span>
                    <span>SAN {character.derived.sanity}</span>
                  </div>
                </div>
              ))}
            </PresencePanel>

            <PresencePanel
              title="在这里的人物"
              icon={<UserRound className="h-4 w-4" />}
              empty="KP 还没有让其他人物在这里出现。"
            >
              {presentNpcs.map((npc) => (
                <div key={npc.id} className="rounded-lg border border-amber-900/40 bg-amber-950/20 p-3">
                  <div className="text-sm font-medium text-amber-100">{npc.name}</div>
                  {npc.description && (
                    <p className="mt-1.5 whitespace-pre-wrap text-xs leading-5 text-zinc-400">{npc.description}</p>
                  )}
                </div>
              ))}
            </PresencePanel>

            <PresencePanel
              title="这里公开的线索与手记"
              icon={<FileText className="h-4 w-4" />}
              empty="守秘人尚未在这里公开线索或手记。"
            >
              {revealedContent.map((content) => (
                <article key={content.contentId} className="rounded-lg border border-emerald-900/40 bg-emerald-950/15 p-3">
                  <div className="text-[10px] uppercase tracking-wide text-emerald-400">
                    {contentTypeLabels[content.contentType]}
                  </div>
                  <div className="mt-1 text-sm font-medium text-emerald-100">{content.title}</div>
                  {content.body && (
                    <p className="mt-1.5 whitespace-pre-wrap text-xs leading-5 text-zinc-400">{content.body}</p>
                  )}
                </article>
              ))}
            </PresencePanel>
          </div>
        </div>
      </div>
    </section>
  );
}

const EMPTY_LOCATION_CONTENT: ReadonlyMap<string, readonly ContentRevealedPayloadV1[]> = new Map();

const contentTypeLabels: Record<ContentRevealedPayloadV1["contentType"], string> = {
  clue: "线索",
  handout: "手记",
  text: "公开文本",
};

function PresencePanel({
  title,
  icon,
  empty,
  children,
}: {
  title: string;
  icon: ReactNode;
  empty: string;
  children: ReactNode;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <section className="rounded-xl border border-white/10 bg-zinc-950/70 p-4 backdrop-blur-sm">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
        <span className="text-brass">{icon}</span>{title}
      </h3>
      <div className="mt-3 grid gap-2">
        {hasChildren ? children : <p className="text-xs leading-5 text-zinc-500">{empty}</p>}
      </div>
    </section>
  );
}

function firstAvailableLocationId(
  available: ReadonlySet<string>,
  ...candidates: Array<string | undefined>
): string | undefined {
  return candidates.find((candidate) => candidate !== undefined && available.has(candidate));
}

function locationBackdrop(locationId: string): CSSProperties {
  const palettes = [
    ["rgba(120, 53, 15, .5)", "rgba(24, 24, 27, .95)"],
    ["rgba(30, 64, 175, .38)", "rgba(9, 9, 11, .96)"],
    ["rgba(22, 101, 52, .35)", "rgba(9, 9, 11, .96)"],
    ["rgba(88, 28, 135, .4)", "rgba(9, 9, 11, .96)"],
  ] as const;
  let hash = 0;
  for (const character of locationId) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  const palette = palettes[hash % palettes.length] ?? palettes[0];
  return {
    backgroundColor: "#09090b",
    backgroundImage: [
      `radial-gradient(circle at 18% 20%, ${palette[0]}, transparent 42%)`,
      `linear-gradient(125deg, transparent 5%, ${palette[1]} 78%)`,
    ].join(", "),
  };
}
