import { useEffect, useMemo, useState } from "react";
import type { ModulePackageV1 } from "@coc-room/protocol";
import { BookOpen, Eye, MapPin, ShieldAlert, UserRound } from "lucide-react";

import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { Input } from "../ui/Field";
import type { PublishedRoomLocation, PublishedRoomNpc } from "./RoomWorldStage";

type ModuleLocation = ModulePackageV1["locations"][number];
type ModuleNpc = ModulePackageV1["npcs"][number];
type ModuleScene = ModulePackageV1["scenes"][number];

export interface KeeperSceneControlsProps {
  /** The exact active module revision loaded from the keeper's local library. */
  readonly modulePackage: ModulePackageV1;
  readonly publishedLocations: ReadonlyMap<string, PublishedRoomLocation>;
  readonly npcsByLocation: ReadonlyMap<string, ReadonlyMap<string, PublishedRoomNpc>>;
  readonly selectedLocationId?: string;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly onSelectLocation?: (locationId: string) => void;
  readonly onPublishLocation: (location: PublishedRoomLocation) => void;
  readonly onPublishNpc: (
    location: PublishedRoomLocation,
    npc: PublishedRoomNpc,
  ) => void;
}

export function KeeperSceneControls({
  modulePackage,
  publishedLocations,
  npcsByLocation,
  selectedLocationId,
  disabled = false,
  disabledReason,
  onSelectLocation,
  onPublishLocation,
  onPublishNpc,
}: KeeperSceneControlsProps) {
  const [uncontrolledLocationId, setUncontrolledLocationId] = useState<string>();
  const locationIds = useMemo(
    () => new Set(modulePackage.locations.map((location) => location.id)),
    [modulePackage.locations],
  );
  const activeLocationId = firstAvailableLocationId(
    locationIds,
    selectedLocationId,
    uncontrolledLocationId,
    modulePackage.locations[0]?.id,
  );
  const activeLocation = modulePackage.locations.find((location) => location.id === activeLocationId);

  useEffect(() => {
    if (uncontrolledLocationId && !locationIds.has(uncontrolledLocationId)) {
      setUncontrolledLocationId(undefined);
    }
  }, [locationIds, uncontrolledLocationId]);

  const selectLocation = (locationId: string) => {
    setUncontrolledLocationId(locationId);
    onSelectLocation?.(locationId);
  };

  return (
    <section aria-label="守秘人场景控制" className="grid gap-4">
      <header className="rounded-xl border border-amber-900/60 bg-amber-950/25 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-[.2em] text-brass">
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />守秘人场景控制
            </p>
            <h2 className="mt-1 truncate font-serif text-lg text-ink">{modulePackage.metadata.title}</h2>
            <p className="mt-1 text-[11px] text-zinc-500">精确修订 v{modulePackage.revision}</p>
          </div>
          <span className="shrink-0 rounded bg-amber-950 px-2 py-1 text-[10px] text-amber-300">仅 KP 可见</span>
        </div>
        <p className="mt-3 text-xs leading-5 text-amber-200/80">
          地点与 NPC 一经公开，就会作为房间事件持久同步给全体成员；界面无法收回其他成员已经保存的副本。
        </p>
      </header>

      {modulePackage.locations.length === 0 || !activeLocation ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
          当前模组修订没有可用地点。
        </div>
      ) : (
        <>
          <nav aria-label="模组全部地点" className="grid max-h-52 gap-1 overflow-y-auto pr-1">
            {modulePackage.locations.map((location) => {
              const selected = location.id === activeLocation.id;
              const published = publishedLocations.has(location.id);
              const relatedSceneCount = modulePackage.scenes.filter(
                (scene) => scene.locationIds.includes(location.id),
              ).length;
              return (
                <button
                  key={location.id}
                  type="button"
                  aria-label={`选择地点：${location.name}`}
                  aria-pressed={selected}
                  onClick={() => selectLocation(location.id)}
                  className={cn(
                    "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass/70",
                    selected
                      ? "border-brass/60 bg-brass/10"
                      : "border-zinc-800 bg-zinc-950/45 hover:border-zinc-700",
                  )}
                >
                  <MapPin className={cn("h-4 w-4", selected ? "text-brass" : "text-zinc-600")} aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-zinc-200">{location.name}</span>
                    <span className="block text-[10px] text-zinc-600">
                      {relatedSceneCount > 0 ? `关联 ${relatedSceneCount} 个场景` : "未分组地点"}
                    </span>
                  </span>
                  {published && <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] text-emerald-300">已公开</span>}
                </button>
              );
            })}
          </nav>

          <LocationPublicationCard
            location={activeLocation}
            scenes={modulePackage.scenes.filter((scene) => scene.locationIds.includes(activeLocation.id))}
            publishedLocation={publishedLocations.get(activeLocation.id)}
            disabled={disabled}
            disabledReason={disabledReason}
            onPublish={onPublishLocation}
          />

          <NpcPublicationDirectory
            location={activeLocation}
            scenes={modulePackage.scenes.filter((scene) => scene.locationIds.includes(activeLocation.id))}
            npcs={modulePackage.npcs}
            publishedLocation={publishedLocations.get(activeLocation.id)}
            npcsByLocation={npcsByLocation}
            disabled={disabled}
            disabledReason={disabledReason}
            onPublish={onPublishNpc}
          />
        </>
      )}
    </section>
  );
}

function LocationPublicationCard({
  location,
  scenes,
  publishedLocation,
  disabled,
  disabledReason,
  onPublish,
}: {
  location: ModuleLocation;
  scenes: readonly ModuleScene[];
  publishedLocation?: PublishedRoomLocation;
  disabled: boolean;
  disabledReason?: string;
  onPublish: (location: PublishedRoomLocation) => void;
}) {
  const playerDescription = location.playerDescription?.trim() ?? "";
  const cannotPublishReason = publishedLocation
    ? "该地点已经公开"
    : !playerDescription
      ? "请先在模组编辑器填写地点的玩家可见描述"
      : disabled
        ? disabledReason ?? "当前无法公开地点"
        : undefined;

  return (
    <article aria-label={`地点发布：${location.name}`} className="grid gap-3 rounded-xl border border-zinc-800 bg-zinc-900/65 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-serif text-lg text-zinc-100">{location.name}</h3>
          {location.aliases.length > 0 && (
            <p className="mt-1 text-[11px] text-zinc-500">别名：{location.aliases.join("、")}</p>
          )}
        </div>
        {publishedLocation && <span className="rounded bg-emerald-950 px-2 py-1 text-[10px] text-emerald-300">已向全房间公开</span>}
      </div>

      <KeeperText label="守秘人地点资料" text={location.description} />

      <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/15 p-3">
        <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-emerald-300">
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />实际发送给玩家
        </div>
        {playerDescription ? (
          <p className="whitespace-pre-wrap text-xs leading-5 text-zinc-300">{playerDescription}</p>
        ) : (
          <p className="text-xs leading-5 text-zinc-500">
            玩家可见描述为空。不会使用上方守秘人资料作为后备文本。
          </p>
        )}
      </div>

      <SceneContext scenes={scenes} />

      <Button
        type="button"
        disabled={Boolean(cannotPublishReason)}
        title={cannotPublishReason}
        onClick={() => onPublish({ id: location.id, name: location.name, description: playerDescription })}
      >
        <Eye className="mr-2 h-4 w-4" aria-hidden="true" />
        {publishedLocation ? "地点已公开" : "向全房间公开地点"}
      </Button>
      {cannotPublishReason && !publishedLocation && (
        <p className={disabled ? "text-xs text-amber-300" : "text-xs text-zinc-500"}>{cannotPublishReason}</p>
      )}
    </article>
  );
}

function SceneContext({ scenes }: { scenes: readonly ModuleScene[] }) {
  return (
    <section aria-label="关联场景" className="rounded-lg border border-zinc-800 bg-zinc-950/45 p-3">
      <h4 className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
        <BookOpen className="h-3.5 w-3.5 text-brass" aria-hidden="true" />关联场景
      </h4>
      {scenes.length === 0 ? (
        <p className="mt-2 text-xs text-zinc-600">这个地点未被任何场景引用，仍可独立公开。</p>
      ) : (
        <div className="mt-2 grid gap-2">
          {scenes.map((scene) => (
            <details key={scene.id} className="rounded border border-zinc-800 bg-zinc-900/60 px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium text-zinc-300">{scene.name}</summary>
              {scene.synopsis && <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-zinc-400">{scene.synopsis}</p>}
              {scene.keeperNotes && (
                <div className="mt-2 rounded border border-amber-900/40 bg-amber-950/15 p-2 text-xs leading-5 text-amber-200/80">
                  {scene.keeperNotes}
                </div>
              )}
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

function NpcPublicationDirectory({
  location,
  scenes,
  npcs,
  publishedLocation,
  npcsByLocation,
  disabled,
  disabledReason,
  onPublish,
}: {
  location: ModuleLocation;
  scenes: readonly ModuleScene[];
  npcs: readonly ModuleNpc[];
  publishedLocation?: PublishedRoomLocation;
  npcsByLocation: ReadonlyMap<string, ReadonlyMap<string, PublishedRoomNpc>>;
  disabled: boolean;
  disabledReason?: string;
  onPublish: (location: PublishedRoomLocation, npc: PublishedRoomNpc) => void;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const relatedNpcIds = new Set(scenes.flatMap((scene) => scene.npcIds));
  const matchingNpcs = npcs.filter((npc) => normalizedQuery.length === 0 || [
    npc.name,
    npc.role,
    npc.playerDescription ?? "",
  ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)));
  const relatedNpcs = matchingNpcs.filter((npc) => relatedNpcIds.has(npc.id));
  const otherNpcs = matchingNpcs.filter((npc) => !relatedNpcIds.has(npc.id));
  const visibleRelatedNpcs = relatedNpcs.slice(0, MAX_VISIBLE_NPCS);
  const visibleOtherNpcs = otherNpcs.slice(0, Math.max(0, MAX_VISIBLE_NPCS - visibleRelatedNpcs.length));
  const hiddenNpcCount = matchingNpcs.length - visibleRelatedNpcs.length - visibleOtherNpcs.length;

  return (
    <section aria-label={`在${location.name}发布 NPC`} className="grid gap-3 rounded-xl border border-zinc-800 bg-zinc-900/65 p-4">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
          <UserRound className="h-4 w-4 text-brass" aria-hidden="true" />让 NPC 在此地出现
        </h3>
        <p className="mt-1 text-xs leading-5 text-zinc-500">
          场景关联人物优先显示；其余模组 NPC 仍全部保留，避免遗漏跨场景人物。
        </p>
      </div>

      <Input
        aria-label="筛选 NPC"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="按姓名、身份或公开稿筛选"
      />

      <NpcGroup
        title="关联 NPC"
        empty="场景没有关联 NPC。"
        npcs={visibleRelatedNpcs}
        location={location}
        publishedLocation={publishedLocation}
        npcsByLocation={npcsByLocation}
        disabled={disabled}
        disabledReason={disabledReason}
        onPublish={onPublish}
      />
      <NpcGroup
        title="其他 NPC"
        empty="没有其他 NPC。"
        npcs={visibleOtherNpcs}
        location={location}
        publishedLocation={publishedLocation}
        npcsByLocation={npcsByLocation}
        disabled={disabled}
        disabledReason={disabledReason}
        onPublish={onPublish}
      />
      {hiddenNpcCount > 0 && (
        <p className="text-xs text-amber-300">
          还有 {hiddenNpcCount} 名 NPC 未显示；请输入更具体的关键词缩小范围。
        </p>
      )}
    </section>
  );
}

const MAX_VISIBLE_NPCS = 100;

function NpcGroup({
  title,
  empty,
  npcs,
  location,
  publishedLocation,
  npcsByLocation,
  disabled,
  disabledReason,
  onPublish,
}: {
  title: string;
  empty: string;
  npcs: readonly ModuleNpc[];
  location: ModuleLocation;
  publishedLocation?: PublishedRoomLocation;
  npcsByLocation: ReadonlyMap<string, ReadonlyMap<string, PublishedRoomNpc>>;
  disabled: boolean;
  disabledReason?: string;
  onPublish: (location: PublishedRoomLocation, npc: PublishedRoomNpc) => void;
}) {
  return (
    <div>
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{title} · {npcs.length}</h4>
      {npcs.length === 0 ? (
        <p className="mt-2 text-xs text-zinc-600">{empty}</p>
      ) : (
        <div className="mt-2 grid gap-2">
          {npcs.map((npc) => (
            <NpcPublishCard
              key={npc.id}
              npc={npc}
              location={location}
              publishedLocation={publishedLocation}
              currentLocationId={findNpcLocationId(npcsByLocation, npc.id)}
              disabled={disabled}
              disabledReason={disabledReason}
              onPublish={onPublish}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NpcPublishCard({
  npc,
  location,
  publishedLocation,
  currentLocationId,
  disabled,
  disabledReason,
  onPublish,
}: {
  npc: ModuleNpc;
  location: ModuleLocation;
  publishedLocation?: PublishedRoomLocation;
  currentLocationId?: string;
  disabled: boolean;
  disabledReason?: string;
  onPublish: (location: PublishedRoomLocation, npc: PublishedRoomNpc) => void;
}) {
  const playerDescription = npc.playerDescription?.trim() ?? "";
  const alreadyHere = currentLocationId === location.id;
  const cannotPublishReason = !publishedLocation
    ? "请先公开地点"
    : !playerDescription
      ? "请先在模组编辑器填写 NPC 的玩家可见描述"
      : alreadyHere
        ? "NPC 已在此地"
        : disabled
          ? disabledReason ?? "当前无法公开 NPC"
          : undefined;

  return (
    <article aria-label={`NPC 发布：${npc.name}`} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-zinc-200">{npc.name}</div>
          {npc.role && <div className="mt-0.5 truncate text-[11px] text-brass">{npc.role}</div>}
        </div>
        <Button
          type="button"
          variant="secondary"
          className="h-8 shrink-0 px-2 text-xs"
          disabled={Boolean(cannotPublishReason)}
          title={cannotPublishReason}
          aria-label={`发布 NPC：${npc.name}`}
          onClick={() => {
            if (!publishedLocation) return;
            onPublish(publishedLocation, {
              id: npc.id,
              name: npc.name,
              description: playerDescription,
            });
          }}
        >
          <Eye className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {alreadyHere ? "已在此地" : currentLocationId ? "移动到此地" : "发布到此地"}
        </Button>
      </div>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-zinc-500">核对公开内容</summary>
        <div className="mt-2 grid gap-2">
          <KeeperText label="守秘人 NPC 资料" text={npc.description} compact />
          <div className="rounded border border-emerald-900/50 bg-emerald-950/15 p-2">
            <div className="text-[10px] font-semibold text-emerald-300">实际发送给玩家</div>
            <p className="mt-1 whitespace-pre-wrap leading-5 text-zinc-400">
              {playerDescription || "玩家可见描述为空；不会发送守秘人资料。"}
            </p>
          </div>
        </div>
      </details>
      {cannotPublishReason && !alreadyHere && (
        <p className={disabled ? "mt-2 text-[11px] text-amber-300" : "mt-2 text-[11px] text-zinc-600"}>{cannotPublishReason}</p>
      )}
    </article>
  );
}

function KeeperText({ label, text, compact = false }: { label: string; text: string; compact?: boolean }) {
  return (
    <div className={cn("rounded-lg border border-amber-900/40 bg-amber-950/15", compact ? "p-2" : "p-3")}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold text-amber-300">
        <ShieldAlert className="h-3 w-3" aria-hidden="true" />{label}
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-xs leading-5 text-amber-100/75">{text || "未填写"}</p>
    </div>
  );
}

function firstAvailableLocationId(
  available: ReadonlySet<string>,
  ...candidates: Array<string | undefined>
): string | undefined {
  return candidates.find((candidate) => candidate !== undefined && available.has(candidate));
}

function findNpcLocationId(
  npcsByLocation: ReadonlyMap<string, ReadonlyMap<string, PublishedRoomNpc>>,
  npcId: string,
): string | undefined {
  for (const [locationId, npcs] of npcsByLocation) {
    if (npcs.has(npcId)) return locationId;
  }
  return undefined;
}
