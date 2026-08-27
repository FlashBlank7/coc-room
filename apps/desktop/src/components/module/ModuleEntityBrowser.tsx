import { useMemo, useState, type ReactNode } from "react";
import type { ModulePackageV1, SourceReferenceV1 } from "@coc-room/protocol";
import {
  BookOpen,
  Clapperboard,
  Dices,
  Eye,
  FileText,
  Lightbulb,
  MapPin,
  Search,
  ShieldAlert,
  Sparkles,
  UserRound,
  Waypoints,
} from "lucide-react";

import { cn } from "../../lib/cn";
import { getModuleParserProvenance } from "../../lib/module-parser";

type Category =
  | "overview"
  | "scenes"
  | "locations"
  | "npcs"
  | "clues"
  | "handouts"
  | "checks"
  | "keeperNotes"
  | "relations";

type ModuleScene = ModulePackageV1["scenes"][number];
type ModuleLocation = ModulePackageV1["locations"][number];
type ModuleNpc = ModulePackageV1["npcs"][number];
type ModuleClue = ModulePackageV1["clues"][number];
type ModuleHandout = ModulePackageV1["handouts"][number];
type ModuleCheck = ModulePackageV1["suggestedChecks"][number];
type ModuleKeeperNote = ModulePackageV1["keeperNotes"][number];
type ModuleRelation = ModulePackageV1["relations"][number];

const categoryDefinitions: ReadonlyArray<{
  id: Category;
  label: string;
  icon: typeof BookOpen;
  count?: keyof Pick<
    ModulePackageV1,
    | "scenes"
    | "locations"
    | "npcs"
    | "clues"
    | "handouts"
    | "suggestedChecks"
    | "keeperNotes"
    | "relations"
  >;
}> = [
  { id: "overview", label: "概览", icon: BookOpen },
  { id: "scenes", label: "场景", icon: Clapperboard, count: "scenes" },
  { id: "locations", label: "地点", icon: MapPin, count: "locations" },
  { id: "npcs", label: "NPC", icon: UserRound, count: "npcs" },
  { id: "clues", label: "线索", icon: Lightbulb, count: "clues" },
  { id: "handouts", label: "文字手记", icon: FileText, count: "handouts" },
  { id: "checks", label: "检定", icon: Dices, count: "suggestedChecks" },
  { id: "keeperNotes", label: "主持人笔记", icon: FileText, count: "keeperNotes" },
  { id: "relations", label: "关系", icon: Waypoints, count: "relations" },
];

export function ModuleEntityBrowser({ modulePackage }: { modulePackage: ModulePackageV1 }) {
  const [category, setCategory] = useState<Category>("overview");
  const [query, setQuery] = useState("");
  const sourceNames = useMemo(
    () => new Map(modulePackage.sourceDocuments.map((source) => [source.id, source.name])),
    [modulePackage.sourceDocuments],
  );
  const entityNames = useMemo(() => buildEntityNames(modulePackage), [modulePackage]);

  const normalizedQuery = query.trim().toLocaleLowerCase();

  return (
    <section className="grid gap-4" aria-label={`${modulePackage.metadata.title}模组内容浏览`}>
      <header className="rounded-xl border border-amber-900/50 bg-amber-950/20 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[.25em] text-brass">Module contents</p>
            <h2 className="mt-1 font-serif text-2xl text-ink">{modulePackage.metadata.title}</h2>
            <p className="mt-1 text-xs text-zinc-500">
              修订 {modulePackage.revision} · {modulePackage.metadata.language}
            </p>
          </div>
          <KeeperBadge label="守秘人视图 · 请勿向玩家共享屏幕" />
        </div>
      </header>

      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="模组内容分类">
          {categoryDefinitions.map((definition) => {
            const Icon = definition.icon;
            const count = definition.count ? modulePackage[definition.count].length : undefined;
            return (
              <button
                key={definition.id}
                type="button"
                role="tab"
                aria-selected={category === definition.id}
                aria-controls="module-entity-panel"
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition",
                  category === definition.id
                    ? "border-brass/70 bg-brass/15 text-amber-200"
                    : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200",
                )}
                onClick={() => setCategory(definition.id)}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {definition.label}
                {count !== undefined && (
                  <span className="rounded-full bg-black/30 px-1.5 py-0.5 text-[10px] text-zinc-400">{count}</span>
                )}
              </button>
            );
          })}
        </div>

        <label className="relative block min-w-60 xl:w-72">
          <span className="sr-only">搜索当前分类</span>
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-zinc-500" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称、正文、ID 或原文摘要"
            className="h-9 w-full rounded-md border border-zinc-700 bg-zinc-950 pl-9 pr-3 text-sm text-ink outline-none transition placeholder:text-zinc-600 focus:border-brass"
          />
        </label>
      </div>

      <div id="module-entity-panel" role="tabpanel" className="grid gap-3">
        <CategoryContent
          category={category}
          modulePackage={modulePackage}
          query={normalizedQuery}
          sourceNames={sourceNames}
          entityNames={entityNames}
        />
      </div>
    </section>
  );
}

function CategoryContent({
  category,
  modulePackage,
  query,
  sourceNames,
  entityNames,
}: {
  category: Category;
  modulePackage: ModulePackageV1;
  query: string;
  sourceNames: ReadonlyMap<string, string>;
  entityNames: ReadonlyMap<string, string>;
}) {
  if (category === "overview") {
    const overviewMatches = matchesQuery(query, [
      modulePackage.metadata,
      modulePackage.overview,
      modulePackage.chapters,
      modulePackage.sourceDocuments,
    ]);
    if (!overviewMatches) return <EmptyResult query={query} />;
    return <OverviewCards modulePackage={modulePackage} entityNames={entityNames} />;
  }

  if (category === "scenes") {
    return (
      <EntityGrid
        items={filterItems(modulePackage.scenes, query)}
        query={query}
        render={(scene) => <SceneCard key={scene.id} scene={scene} sourceNames={sourceNames} entityNames={entityNames} />}
      />
    );
  }
  if (category === "locations") {
    return (
      <EntityGrid
        items={filterItems(modulePackage.locations, query)}
        query={query}
        render={(location) => <LocationCard key={location.id} location={location} sourceNames={sourceNames} />}
      />
    );
  }
  if (category === "npcs") {
    return (
      <EntityGrid
        items={filterItems(modulePackage.npcs, query)}
        query={query}
        render={(npc) => <NpcCard key={npc.id} npc={npc} sourceNames={sourceNames} />}
      />
    );
  }
  if (category === "clues") {
    return (
      <EntityGrid
        items={filterItems(modulePackage.clues, query)}
        query={query}
        render={(clue) => <ClueCard key={clue.id} clue={clue} sourceNames={sourceNames} />}
      />
    );
  }
  if (category === "handouts") {
    return (
      <EntityGrid
        items={filterItems(modulePackage.handouts, query)}
        query={query}
        render={(handout) => <HandoutCard key={handout.id} handout={handout} sourceNames={sourceNames} />}
      />
    );
  }
  if (category === "checks") {
    return (
      <EntityGrid
        items={filterItems(modulePackage.suggestedChecks, query)}
        query={query}
        render={(check) => <CheckCard key={check.id} check={check} sourceNames={sourceNames} />}
      />
    );
  }
  if (category === "keeperNotes") {
    return (
      <EntityGrid
        items={filterItems(modulePackage.keeperNotes, query)}
        query={query}
        render={(note) => <KeeperNoteCard key={note.id} note={note} sourceNames={sourceNames} entityNames={entityNames} />}
      />
    );
  }
  return (
    <EntityGrid
      items={filterItems(modulePackage.relations, query)}
      query={query}
      render={(relation) => <RelationCard key={relation.id} relation={relation} sourceNames={sourceNames} entityNames={entityNames} />}
    />
  );
}

function OverviewCards({
  modulePackage,
  entityNames,
}: {
  modulePackage: ModulePackageV1;
  entityNames: ReadonlyMap<string, string>;
}) {
  const parserProvenance = getModuleParserProvenance(modulePackage);
  const stats = [
    ["场景", modulePackage.scenes.length],
    ["地点", modulePackage.locations.length],
    ["NPC", modulePackage.npcs.length],
    ["线索", modulePackage.clues.length],
    ["文字手记", modulePackage.handouts.length],
    ["检定", modulePackage.suggestedChecks.length],
    ["关系", modulePackage.relations.length],
  ] as const;

  return (
    <>
      <article className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-5">
        <div className="flex flex-wrap gap-2">
          {stats.map(([label, value]) => (
            <div key={label} className="min-w-20 rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2">
              <div className="text-xl font-semibold text-ink">{value}</div>
              <div className="text-[11px] text-zinc-500">{label}</div>
            </div>
          ))}
        </div>
        {modulePackage.metadata.summary && (
          <div className="mt-5">
            <SectionLabel>简介</SectionLabel>
            <RichText>{modulePackage.metadata.summary}</RichText>
          </div>
        )}
        {modulePackage.overview && (
          <div className="mt-5 rounded-lg border border-amber-900/40 bg-amber-950/15 p-4">
            <div className="mb-2 flex items-center gap-2">
              <SectionLabel>剧情概览</SectionLabel>
              <KeeperBadge />
            </div>
            <RichText>{modulePackage.overview}</RichText>
          </div>
        )}
        <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
          <MetadataRow label="作者" value={modulePackage.metadata.authors.join("、") || "未注明"} />
          <MetadataRow label="模块 ID" value={modulePackage.moduleId} code />
          <MetadataRow label="建立时间" value={formatDate(modulePackage.metadata.createdAt)} />
          <MetadataRow label="更新时间" value={formatDate(modulePackage.metadata.updatedAt)} />
        </dl>
      </article>

      <article aria-label="解析来源" className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-5">
        <SectionHeading icon={<Sparkles className="h-4 w-4" />} title="解析来源" />
        {!parserProvenance ? (
          <p className="mt-3 text-sm text-zinc-500">来源未记录</p>
        ) : (
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <MetadataRow label="解析服务" value={formatParserProvider(parserProvenance.provider)} />
            <MetadataRow label="模型" value={parserProvenance.model} code />
            <MetadataRow label="解析时间" value={formatDate(parserProvenance.parsedAt)} />
            <MetadataRow label="状态" value={formatParserStatus(parserProvenance.status)} />
            <MetadataRow label="调用次数" value={parserProvenance.usage.calls?.toString() ?? "未记录"} />
            <MetadataRow label="原始来源" value={parserProvenance.sourceName} />
            <MetadataRow label="解析问题" value={`${parserProvenance.issues.length} 条`} />
          </dl>
        )}
      </article>

      {modulePackage.chapters.length > 0 && (
        <article className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-5">
          <SectionHeading icon={<BookOpen className="h-4 w-4" />} title="章节" />
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {[...modulePackage.chapters]
              .sort((left, right) => left.order - right.order)
              .map((chapter) => (
                <div key={chapter.id} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="font-medium text-ink">{chapter.title}</h4>
                    <EntityId>{chapter.id}</EntityId>
                  </div>
                  {chapter.notes && <RichText className="mt-2 text-xs">{chapter.notes}</RichText>}
                  <RelatedIds label="场景 ID" ids={chapter.sceneIds} entityNames={entityNames} />
                </div>
              ))}
          </div>
        </article>
      )}

      <article className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-5">
        <SectionHeading icon={<FileText className="h-4 w-4" />} title="来源文档" />
        <div className="mt-3 grid gap-2">
          {modulePackage.sourceDocuments.length === 0 && <p className="text-sm text-zinc-500">没有来源文档记录。</p>}
          {modulePackage.sourceDocuments.map((source) => (
            <div key={source.id} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 text-sm">
              <div className="font-medium text-zinc-200">{source.name}</div>
              <div className="mt-1 break-all font-mono text-[11px] text-zinc-500">{source.id}</div>
              <div className="mt-1 text-xs text-zinc-500">{source.mediaType}</div>
            </div>
          ))}
        </div>
      </article>
    </>
  );
}

function SceneCard({
  scene,
  sourceNames,
  entityNames,
}: {
  scene: ModuleScene;
  sourceNames: ReadonlyMap<string, string>;
  entityNames: ReadonlyMap<string, string>;
}) {
  return (
    <EntityCard id={scene.id} title={scene.name} keeper>
      <RichText>{scene.description}</RichText>
      {scene.synopsis && <DetailBlock label="场景摘要" text={scene.synopsis} />}
      <div className="grid gap-2 sm:grid-cols-2">
        <RelatedIds label="地点 ID" ids={scene.locationIds} entityNames={entityNames} />
        <RelatedIds label="NPC ID" ids={scene.npcIds} entityNames={entityNames} />
        <RelatedIds label="线索 ID" ids={scene.clueIds} entityNames={entityNames} />
        <RelatedIds label="手记 ID" ids={scene.handoutIds} entityNames={entityNames} />
        <RelatedIds label="检定 ID" ids={scene.suggestedCheckIds} entityNames={entityNames} />
      </div>
      {scene.keeperNotes && (
        <SecretBlock label="场景主持人笔记">
          <RichText>{scene.keeperNotes}</RichText>
        </SecretBlock>
      )}
      <SourceReferences references={scene.sourceRefs} sourceNames={sourceNames} />
    </EntityCard>
  );
}

function LocationCard({
  location,
  sourceNames,
}: {
  location: ModuleLocation;
  sourceNames: ReadonlyMap<string, string>;
}) {
  return (
    <EntityCard id={location.id} title={location.name} keeper>
      <RichText>{location.description}</RichText>
      {location.aliases.length > 0 && <TagList label="别名" values={location.aliases} />}
      <SourceReferences references={location.sourceRefs} sourceNames={sourceNames} />
    </EntityCard>
  );
}

function NpcCard({ npc, sourceNames }: { npc: ModuleNpc; sourceNames: ReadonlyMap<string, string> }) {
  return (
    <EntityCard id={npc.id} title={npc.name} subtitle={npc.role} keeper>
      <RichText>{npc.description}</RichText>
      {npc.motivation && <DetailBlock label="动机" text={npc.motivation} secret />}
      {npc.traits.length > 0 && <TagList label="特征" values={npc.traits} />}
      {npc.character && (
        <div className="grid gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 sm:grid-cols-2">
          <StatBlock label="属性" values={npc.character.characteristics} />
          <StatBlock label="技能" values={npc.character.skills} />
          {(npc.character.hitPoints !== undefined || npc.character.sanity !== undefined) && (
            <div className="flex gap-3 text-xs text-zinc-300 sm:col-span-2">
              {npc.character.hitPoints !== undefined && <span>HP {npc.character.hitPoints}</span>}
              {npc.character.sanity !== undefined && <span>SAN {npc.character.sanity}</span>}
            </div>
          )}
        </div>
      )}
      <SourceReferences references={npc.sourceRefs} sourceNames={sourceNames} />
    </EntityCard>
  );
}

function ClueCard({ clue, sourceNames }: { clue: ModuleClue; sourceNames: ReadonlyMap<string, string> }) {
  return (
    <EntityCard
      id={clue.id}
      title={clue.name}
      keeper
      headerExtra={clue.isCore ? <span className="rounded bg-red-950 px-2 py-1 text-[10px] text-red-300">核心线索</span> : undefined}
    >
      <SecretBlock label="守秘人线索说明">
        <RichText>{clue.description}</RichText>
      </SecretBlock>
      <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/20 p-3">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-emerald-300">
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
          经确认可向玩家公开
        </div>
        {clue.revealText ? (
          <RichText>{clue.revealText}</RichText>
        ) : (
          <p className="text-xs text-zinc-500">尚无玩家可见文本，不能直接公开。</p>
        )}
      </div>
      <SourceReferences references={clue.sourceRefs} sourceNames={sourceNames} />
    </EntityCard>
  );
}

function HandoutCard({
  handout,
  sourceNames,
}: {
  handout: ModuleHandout;
  sourceNames: ReadonlyMap<string, string>;
}) {
  return (
    <EntityCard id={handout.id} title={handout.title} subtitle={handout.name} keeper>
      {handout.description && (
        <SecretBlock label="守秘人说明">
          <RichText>{handout.description}</RichText>
        </SecretBlock>
      )}
      <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/20 p-3">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-emerald-300">
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
          经确认可向玩家公开的手记正文
        </div>
        {handout.content ? (
          <RichText>{handout.content}</RichText>
        ) : (
          <p className="text-xs text-zinc-500">手记正文为空，不能直接公开。</p>
        )}
      </div>
      <SourceReferences references={handout.sourceRefs} sourceNames={sourceNames} />
    </EntityCard>
  );
}

function CheckCard({ check, sourceNames }: { check: ModuleCheck; sourceNames: ReadonlyMap<string, string> }) {
  const difficulty = { regular: "普通", hard: "困难", extreme: "极难" }[check.difficulty];
  return (
    <EntityCard id={check.id} title={check.skill} subtitle={`${difficulty}难度`} keeper>
      <DetailBlock label="检定目的" text={check.purpose} />
      <div className="grid gap-3 sm:grid-cols-2">
        <DetailBlock label="成功" text={check.onSuccess} tone="success" />
        <DetailBlock label="失败" text={check.onFailure} tone="danger" />
      </div>
      <SourceReferences references={check.sourceRefs} sourceNames={sourceNames} />
    </EntityCard>
  );
}

function KeeperNoteCard({
  note,
  sourceNames,
  entityNames,
}: {
  note: ModuleKeeperNote;
  sourceNames: ReadonlyMap<string, string>;
  entityNames: ReadonlyMap<string, string>;
}) {
  return (
    <EntityCard id={note.id} title={note.title} keeper>
      <SecretBlock label="主持人笔记">
        <RichText>{note.content}</RichText>
      </SecretBlock>
      <RelatedIds label="关联实体 ID" ids={note.relatedEntityIds} entityNames={entityNames} />
      <SourceReferences references={note.sourceRefs} sourceNames={sourceNames} />
    </EntityCard>
  );
}

function RelationCard({
  relation,
  sourceNames,
  entityNames,
}: {
  relation: ModuleRelation;
  sourceNames: ReadonlyMap<string, string>;
  entityNames: ReadonlyMap<string, string>;
}) {
  return (
    <EntityCard id={relation.id} title={relation.kind} keeper>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
        <RelationEndpoint label="来源实体 ID" id={relation.fromEntityId} entityNames={entityNames} />
        <Waypoints className="hidden h-4 w-4 text-brass sm:block" aria-hidden="true" />
        <RelationEndpoint label="目标实体 ID" id={relation.toEntityId} entityNames={entityNames} />
      </div>
      {relation.description && <DetailBlock label="关系说明" text={relation.description} />}
      <SourceReferences references={relation.sourceRefs} sourceNames={sourceNames} />
    </EntityCard>
  );
}

function EntityGrid<T>({ items, query, render }: { items: readonly T[]; query: string; render: (item: T) => ReactNode }) {
  if (items.length === 0) return <EmptyResult query={query} />;
  return <div className="grid items-start gap-3 xl:grid-cols-2">{items.map(render)}</div>;
}

function EntityCard({
  id,
  title,
  subtitle,
  keeper,
  headerExtra,
  children,
}: {
  id: string;
  title: string;
  subtitle?: string;
  keeper?: boolean;
  headerExtra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article className="grid gap-4 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-800 pb-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-serif text-lg text-ink">{title}</h3>
            {headerExtra}
          </div>
          {subtitle && <p className="mt-1 text-xs text-brass">{subtitle}</p>}
          <div className="mt-2"><EntityId>{id}</EntityId></div>
        </div>
        {keeper && <KeeperBadge />}
      </header>
      {children}
    </article>
  );
}

function KeeperBadge({ label = "守秘人内容" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-amber-800/70 bg-amber-950/50 px-2 py-1 text-[10px] font-semibold text-amber-300">
      <ShieldAlert className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  );
}

function EntityId({ children }: { children: string }) {
  return <code className="break-all rounded bg-zinc-950 px-1.5 py-1 text-[10px] text-zinc-500">{children}</code>;
}

function RelatedIds({
  label,
  ids,
  entityNames,
}: {
  label: string;
  ids: readonly string[];
  entityNames: ReadonlyMap<string, string>;
}) {
  if (ids.length === 0) return null;
  return (
    <div className="mt-3">
      <SectionLabel>{label}</SectionLabel>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {ids.map((id) => <EntityReference key={id} id={id} entityNames={entityNames} />)}
      </div>
    </div>
  );
}

function SourceReferences({
  references,
  sourceNames,
}: {
  references: readonly SourceReferenceV1[];
  sourceNames: ReadonlyMap<string, string>;
}) {
  if (references.length === 0) return null;
  return (
    <details className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-zinc-400">
        原文定位 · {references.length} 处
      </summary>
      <div className="mt-2 grid gap-2">
        {references.map((reference, index) => (
          <div key={`${reference.sourceId}-${reference.start}-${reference.end}-${index}`} className="border-l-2 border-brass/40 pl-3">
            <div className="text-[11px] text-zinc-400">
              <span className="text-zinc-300">{sourceNames.get(reference.sourceId) ?? "未知来源"}</span>
              <span> · 字符 {reference.start}–{reference.end}</span>
            </div>
            <div className="mt-0.5 break-all font-mono text-[10px] text-zinc-600">{reference.sourceId}</div>
            {reference.excerpt && <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-zinc-500">{reference.excerpt}</p>}
          </div>
        ))}
      </div>
    </details>
  );
}

function DetailBlock({
  label,
  text,
  secret,
  tone = "default",
}: {
  label: string;
  text: string;
  secret?: boolean;
  tone?: "default" | "success" | "danger";
}) {
  if (!text) return null;
  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        tone === "default" && "border-zinc-800 bg-zinc-950/45",
        tone === "success" && "border-emerald-900/60 bg-emerald-950/20",
        tone === "danger" && "border-red-900/60 bg-red-950/20",
      )}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <SectionLabel>{label}</SectionLabel>
        {secret && <KeeperBadge />}
      </div>
      <RichText>{text}</RichText>
    </div>
  );
}

function SecretBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <SectionLabel>{label}</SectionLabel>
        <KeeperBadge />
      </div>
      {children}
    </div>
  );
}

function TagList({ label, values }: { label: string; values: readonly string[] }) {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {values.map((value) => <span key={value} className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300">{value}</span>)}
      </div>
    </div>
  );
}

function StatBlock({ label, values }: { label: string; values: Record<string, number> }) {
  const entries = Object.entries(values);
  if (entries.length === 0) return null;
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {entries.map(([name, value]) => <span key={name} className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300">{name} {value}</span>)}
      </div>
    </div>
  );
}

function RelationEndpoint({
  label,
  id,
  entityNames,
}: {
  label: string;
  id: string;
  entityNames: ReadonlyMap<string, string>;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
      <SectionLabel>{label}</SectionLabel>
      <div className="mt-2"><EntityReference id={id} entityNames={entityNames} /></div>
    </div>
  );
}

function EntityReference({ id, entityNames }: { id: string; entityNames: ReadonlyMap<string, string> }) {
  const name = entityNames.get(id);
  return (
    <span className="inline-flex max-w-full flex-col gap-1 rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1.5">
      {name && <span className="text-xs text-zinc-300">{name}</span>}
      <code className="break-all text-[10px] text-zinc-500">{id}</code>
    </span>
  );
}

function MetadataRow({ label, value, code }: { label: string; value: string; code?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className={cn("mt-1 break-all text-zinc-300", code && "font-mono text-xs")}>{value}</dd>
    </div>
  );
}

function SectionHeading({ icon, title }: { icon: ReactNode; title: string }) {
  return <h3 className="flex items-center gap-2 font-semibold text-ink"><span className="text-brass">{icon}</span>{title}</h3>;
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{children}</span>;
}

function RichText({ children, className }: { children: string; className?: string }) {
  return <p className={cn("whitespace-pre-wrap text-sm leading-6 text-zinc-300", className)}>{children}</p>;
}

function EmptyResult({ query }: { query: string }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-10 text-center text-sm text-zinc-500">
      {query ? `没有与“${query}”匹配的内容。` : "这个分类暂时没有内容。"}
    </div>
  );
}

function filterItems<T>(items: readonly T[], query: string): T[] {
  if (!query) return [...items];
  return items.filter((item) => matchesQuery(query, [item]));
}

function matchesQuery(query: string, values: readonly unknown[]): boolean {
  if (!query) return true;
  return values.some((value) => searchableText(value).includes(query));
}

function searchableText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).toLocaleLowerCase();
  }
  if (Array.isArray(value)) return value.map(searchableText).join(" ");
  if (typeof value === "object") return Object.values(value).map(searchableText).join(" ");
  return "";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function formatParserProvider(value: string): string {
  if (value === "deepseek") return "DeepSeek API";
  if (value === "mock") return "内置模拟解析";
  return value;
}

function formatParserStatus(value: string): string {
  if (value === "ready_for_review") return "可供人工复核";
  if (value === "needs_review") return "需要人工修正";
  return value;
}

function buildEntityNames(modulePackage: ModulePackageV1): Map<string, string> {
  const names = new Map<string, string>();
  const add = (id: string, name: string) => names.set(id, name);
  modulePackage.chapters.forEach((chapter) => add(chapter.id, chapter.title));
  modulePackage.scenes.forEach((scene) => add(scene.id, scene.name));
  modulePackage.locations.forEach((location) => add(location.id, location.name));
  modulePackage.npcs.forEach((npc) => add(npc.id, npc.name));
  modulePackage.clues.forEach((clue) => add(clue.id, clue.name));
  modulePackage.handouts.forEach((handout) => add(handout.id, handout.title));
  modulePackage.suggestedChecks.forEach((check) => add(check.id, `${check.skill}检定`));
  modulePackage.keeperNotes.forEach((note) => add(note.id, note.title));
  return names;
}
