import { useEffect, useMemo, useState, type ReactNode } from "react";
import { LockKeyhole, Plus, Save, Trash2, UserRound } from "lucide-react";
import { coc7CharacterSchema, type Coc7Character } from "@coc-room/protocol";
import type { RoomSession } from "../network/RoomSession";
import { useAppStore } from "../store/app-store";
import { deriveCoc7Stats } from "../lib/character-derivation";
import { Button } from "../components/ui/Button";
import { Field, Input, Textarea } from "../components/ui/Field";
import { Panel } from "../components/ui/Panel";

type CharacteristicKey = keyof Coc7Character["characteristics"];
type StatusKey = keyof Coc7Character["status"];
type BackgroundKey = keyof Coc7Character["background"];
type Skill = Coc7Character["skills"][number];
type InventoryItem = Coc7Character["inventory"][number];
type CurrentResourceKey = "hitPoints" | "magicPoints" | "sanity";

const characteristicLabels: Record<CharacteristicKey, string> = {
  str: "力量 STR",
  con: "体质 CON",
  siz: "体型 SIZ",
  dex: "敏捷 DEX",
  app: "外貌 APP",
  int: "智力 INT",
  pow: "意志 POW",
  edu: "教育 EDU",
  luck: "幸运 LUCK",
};

const statusLabels: Record<StatusKey, string> = {
  temporaryInsanity: "临时性疯狂",
  indefiniteInsanity: "不定性疯狂",
  majorWound: "重伤",
  dying: "濒死",
  unconscious: "昏迷",
};

const backgroundFields: ReadonlyArray<readonly [BackgroundKey, string]> = [
  ["personalDescription", "个人描述"],
  ["ideologyAndBeliefs", "思想与信念"],
  ["significantPeople", "重要之人"],
  ["meaningfulLocations", "意义非凡之地"],
  ["treasuredPossessions", "宝贵之物"],
  ["traits", "特质"],
  ["injuriesAndScars", "伤口与疤痕"],
  ["phobiasAndManias", "恐惧症与躁狂症"],
  ["arcaneTomesSpellsAndArtifacts", "奥秘典籍、法术与神秘物品"],
  ["encountersWithStrangeEntities", "遭遇的奇异实体"],
];

const currentResourceMaximum: Record<CurrentResourceKey, keyof Coc7Character["derived"]> = {
  hitPoints: "maxHitPoints",
  magicPoints: "maxMagicPoints",
  sanity: "maxSanity",
};

export function CharactersView({ session }: { session?: RoomSession }) {
  const events = useAppStore((state) => state.events);
  const currentRoom = useAppStore((state) => state.currentRoom);
  const characters = useMemo(() => {
    const byId = new Map<string, Coc7Character>();
    for (const event of events) {
      if (event.type === "character.updated") byId.set(event.payload.character.id, event.payload.character);
    }
    return [...byId.values()];
  }, [events]);
  const own = characters.find((character) => character.ownerPeerId === currentRoom?.localPeerId);
  const [draft, setDraft] = useState<Coc7Character>(() => own ?? createCharacter(
    currentRoom?.localPeerId ?? crypto.randomUUID(),
    session?.participant.displayName ?? "调查员",
  ));
  const [draftRoomId, setDraftRoomId] = useState(currentRoom?.id);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!currentRoom || draftRoomId === currentRoom.id) return;
    setDraft(own ?? createCharacter(currentRoom.localPeerId, session?.participant.displayName ?? "调查员"));
    setDraftRoomId(currentRoom.id);
    setDirty(false);
    setError(undefined);
  }, [currentRoom, draftRoomId, own, session?.participant.displayName]);

  useEffect(() => {
    if (!currentRoom || dirty) return;
    const synchronized = characters.find((character) => character.id === draft.id);
    if (synchronized && synchronized.updatedAt !== draft.updatedAt) {
      setDraft(synchronized);
      return;
    }
    if (!synchronized && own && draft.ownerPeerId === currentRoom.localPeerId && draft.id !== own.id) {
      setDraft(own);
    }
  }, [characters, currentRoom, dirty, draft.id, draft.ownerPeerId, draft.updatedAt, own]);

  if (!currentRoom) {
    return <div className="grid h-full place-items-center text-zinc-500">加入房间后才能编辑角色卡</div>;
  }

  const canEdit = Boolean(session && (session.isHost || draft.ownerPeerId === currentRoom.localPeerId));

  const editDraft = (
    updater: (current: Coc7Character) => Coc7Character,
    recalculateDerived = false,
  ) => {
    setDraft((current) => {
      const next = updater(current);
      if (!recalculateDerived) return next;
      return {
        ...next,
        derived: deriveCoc7Stats({
          characteristics: next.characteristics,
          age: next.age,
          skills: next.skills,
          current: next.derived,
        }),
      };
    });
    setDirty(true);
    setError(undefined);
  };

  const selectCharacter = (character: Coc7Character) => {
    setDraft(character);
    setDirty(false);
    setError(undefined);
  };

  const updateCharacteristic = (key: CharacteristicKey, value: number) => {
    editDraft((current) => ({
      ...current,
      characteristics: { ...current.characteristics, [key]: value },
    }), true);
  };

  const updateCurrentResource = (key: CurrentResourceKey, value: number) => {
    editDraft((current) => {
      const maximum = Number(current.derived[currentResourceMaximum[key]]);
      return {
        ...current,
        derived: {
          ...current.derived,
          [key]: clampInteger(value, 0, maximum),
        },
      };
    });
  };

  const addSkill = () => {
    editDraft((current) => ({
      ...current,
      skills: [...current.skills, createSkill()],
    }), true);
  };

  const updateSkill = (id: string, update: (skill: Skill) => Skill) => {
    editDraft((current) => ({
      ...current,
      skills: current.skills.map((skill) => skill.id === id ? update(skill) : skill),
    }), true);
  };

  const removeSkill = (id: string) => {
    editDraft((current) => ({
      ...current,
      skills: current.skills.filter((skill) => skill.id !== id),
    }), true);
  };

  const addInventoryItem = () => {
    editDraft((current) => ({
      ...current,
      inventory: [...current.inventory, createInventoryItem()],
    }));
  };

  const updateInventoryItem = (id: string, update: (item: InventoryItem) => InventoryItem) => {
    editDraft((current) => ({
      ...current,
      inventory: current.inventory.map((item) => item.id === id ? update(item) : item),
    }));
  };

  const removeInventoryItem = (id: string) => {
    editDraft((current) => ({
      ...current,
      inventory: current.inventory.filter((item) => item.id !== id),
    }));
  };

  const saveCharacter = async () => {
    try {
      if (!session || (!session.isHost && draft.ownerPeerId !== currentRoom.localPeerId)) {
        throw new Error("玩家只能保存自己的角色卡");
      }
      const recalculated = {
        ...draft,
        derived: deriveCoc7Stats({
          characteristics: draft.characteristics,
          age: draft.age,
          skills: draft.skills,
          current: draft.derived,
        }),
        updatedAt: new Date().toISOString(),
      };
      const character = coc7CharacterSchema.parse(recalculated);
      await session.submit("character.update", { character });
      setDraft(character);
      setDirty(false);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4 md:p-7">
      <div className="mx-auto grid max-w-7xl gap-6">
        <header>
          <p className="text-xs uppercase tracking-[.3em] text-brass">CoC seventh edition</p>
          <h1 className="mt-2 font-serif text-3xl">调查员角色卡</h1>
        </header>

        <div className="grid gap-5 lg:grid-cols-[250px_minmax(0,1fr)]">
          <Panel className="content-start lg:sticky lg:top-0">
            <h2 className="mb-3 font-semibold">本房间角色</h2>
            <div className="grid gap-2">
              {characters.map((character) => (
                <button
                  key={character.id}
                  type="button"
                  onClick={() => selectCharacter(character)}
                  className={`rounded-md border p-3 text-left transition ${
                    draft.id === character.id
                      ? "border-brass/60 bg-amber-950/20"
                      : "border-transparent bg-zinc-900 hover:bg-zinc-800"
                  }`}
                >
                  <div className="font-medium">{character.name}</div>
                  <div className="mt-1 text-xs text-zinc-500">
                    {character.occupation || "无职业"} · {character.playerName}
                  </div>
                </button>
              ))}
              {!own && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setDraft(createCharacter(currentRoom.localPeerId, session?.participant.displayName ?? "调查员"));
                    setDirty(true);
                    setError(undefined);
                  }}
                >
                  <UserRound className="mr-2 h-4 w-4" />新建我的角色
                </Button>
              )}
            </div>
          </Panel>

          <Panel className="grid gap-8">
            {!canEdit && (
              <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-400">
                <LockKeyhole className="h-4 w-4 shrink-0" />
                只有角色所有者与主持人可以修改这张角色卡。
              </div>
            )}

            <Section title="调查员信息">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Field label="姓名">
                  <Input disabled={!canEdit} maxLength={160} value={draft.name} onChange={(event) => editDraft((current) => ({ ...current, name: event.target.value }))} />
                </Field>
                <Field label="玩家">
                  <Input disabled={!canEdit} maxLength={160} value={draft.playerName} onChange={(event) => editDraft((current) => ({ ...current, playerName: event.target.value }))} />
                </Field>
                <Field label="职业">
                  <Input disabled={!canEdit} maxLength={160} value={draft.occupation} onChange={(event) => editDraft((current) => ({ ...current, occupation: event.target.value }))} />
                </Field>
                <Field label="年龄" hint="40 岁起会降低移动力">
                  <Input
                    disabled={!canEdit}
                    type="number"
                    min={15}
                    max={120}
                    value={draft.age}
                    onChange={(event) => editDraft((current) => ({ ...current, age: Number(event.target.value) }), true)}
                  />
                </Field>
                <Field label="居住地">
                  <Input disabled={!canEdit} maxLength={240} value={draft.residence} onChange={(event) => editDraft((current) => ({ ...current, residence: event.target.value }))} />
                </Field>
                <Field label="出生地">
                  <Input disabled={!canEdit} maxLength={240} value={draft.birthplace} onChange={(event) => editDraft((current) => ({ ...current, birthplace: event.target.value }))} />
                </Field>
              </div>
            </Section>

            <Section title="属性" description="修改属性后，生命、魔法、移动力、体格与伤害加值会自动重新计算。">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                {(Object.entries(characteristicLabels) as Array<[CharacteristicKey, string]>).map(([key, label]) => (
                  <Field key={key} label={label}>
                    <Input
                      disabled={!canEdit}
                      type="number"
                      min={0}
                      max={100}
                      value={draft.characteristics[key]}
                      onChange={(event) => updateCharacteristic(key, clampInteger(Number(event.target.value), 0, 100))}
                    />
                  </Field>
                ))}
              </div>
            </Section>

            <Section title="派生数值" description="当前值可随游戏进程调整；上限及其他数值由规则自动计算。">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="当前生命 HP" hint={`上限 ${draft.derived.maxHitPoints}`}>
                  <Input disabled={!canEdit} type="number" min={0} max={draft.derived.maxHitPoints} value={draft.derived.hitPoints} onChange={(event) => updateCurrentResource("hitPoints", Number(event.target.value))} />
                </Field>
                <Field label="当前魔法 MP" hint={`上限 ${draft.derived.maxMagicPoints}`}>
                  <Input disabled={!canEdit} type="number" min={0} max={draft.derived.maxMagicPoints} value={draft.derived.magicPoints} onChange={(event) => updateCurrentResource("magicPoints", Number(event.target.value))} />
                </Field>
                <Field label="当前理智 SAN" hint={`上限 ${draft.derived.maxSanity}`}>
                  <Input disabled={!canEdit} type="number" min={0} max={draft.derived.maxSanity} value={draft.derived.sanity} onChange={(event) => updateCurrentResource("sanity", Number(event.target.value))} />
                </Field>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                <DerivedValue label="最大 HP" value={draft.derived.maxHitPoints} />
                <DerivedValue label="最大 MP" value={draft.derived.maxMagicPoints} />
                <DerivedValue label="最大 SAN" value={draft.derived.maxSanity} />
                <DerivedValue label="移动力 MOV" value={draft.derived.movementRate} />
                <DerivedValue label="体格" value={draft.derived.build} />
                <DerivedValue label="伤害加值" value={draft.derived.damageBonus} />
              </div>
            </Section>

            <Section title="技能" description="克苏鲁神话技能会自动降低最大 SAN。">
              <div className="grid gap-3">
                {draft.skills.map((skill) => (
                  <div key={skill.id} className="grid gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 md:grid-cols-2 xl:grid-cols-[minmax(9rem,1.5fr)_minmax(8rem,1fr)_7rem_7rem_auto_auto] xl:items-end">
                    <Field label="技能名">
                      <Input disabled={!canEdit} maxLength={120} value={skill.name} onChange={(event) => updateSkill(skill.id, (current) => ({ ...current, name: event.target.value }))} />
                    </Field>
                    <Field label="专攻（可选）">
                      <Input
                        disabled={!canEdit}
                        maxLength={120}
                        value={skill.specialization ?? ""}
                        onChange={(event) => updateSkill(skill.id, (current) => {
                          const specialization = event.target.value;
                          if (!specialization) {
                            const { specialization: _removed, ...withoutSpecialization } = current;
                            return withoutSpecialization;
                          }
                          return { ...current, specialization };
                        })}
                      />
                    </Field>
                    <Field label="基础值">
                      <Input disabled={!canEdit} type="number" min={0} max={100} value={skill.baseValue} onChange={(event) => updateSkill(skill.id, (current) => ({ ...current, baseValue: clampInteger(Number(event.target.value), 0, 100) }))} />
                    </Field>
                    <Field label="当前值">
                      <Input disabled={!canEdit} type="number" min={0} max={100} value={skill.value} onChange={(event) => updateSkill(skill.id, (current) => ({ ...current, value: clampInteger(Number(event.target.value), 0, 100) }))} />
                    </Field>
                    <label className="flex h-10 items-center gap-2 text-sm text-zinc-300">
                      <input disabled={!canEdit} type="checkbox" checked={skill.checked} onChange={(event) => updateSkill(skill.id, (current) => ({ ...current, checked: event.target.checked }))} />
                      成长标记
                    </label>
                    <Button disabled={!canEdit} type="button" variant="ghost" className="px-3 text-red-300" aria-label={`删除技能 ${skill.name}`} onClick={() => removeSkill(skill.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                {draft.skills.length === 0 && <EmptyState>尚未添加技能。</EmptyState>}
                <Button disabled={!canEdit || draft.skills.length >= 200} type="button" variant="secondary" className="justify-self-start" onClick={addSkill}>
                  <Plus className="mr-2 h-4 w-4" />添加技能
                </Button>
              </div>
            </Section>

            <Section title="状态">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                {(Object.entries(statusLabels) as Array<[StatusKey, string]>).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-3 text-sm text-zinc-300">
                    <input
                      disabled={!canEdit}
                      type="checkbox"
                      checked={draft.status[key]}
                      onChange={(event) => editDraft((current) => ({ ...current, status: { ...current.status, [key]: event.target.checked } }))}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </Section>

            <Section title="物品与装备">
              <div className="grid gap-3">
                {draft.inventory.map((item) => (
                  <div key={item.id} className="grid gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 md:grid-cols-[minmax(10rem,1fr)_7rem_auto_auto] md:items-end">
                    <Field label="物品名">
                      <Input disabled={!canEdit} maxLength={160} value={item.name} onChange={(event) => updateInventoryItem(item.id, (current) => ({ ...current, name: event.target.value }))} />
                    </Field>
                    <Field label="数量">
                      <Input disabled={!canEdit} type="number" min={0} value={item.quantity} onChange={(event) => updateInventoryItem(item.id, (current) => ({ ...current, quantity: Math.max(0, Math.trunc(Number(event.target.value))) }))} />
                    </Field>
                    <label className="flex h-10 items-center gap-2 text-sm text-zinc-300">
                      <input disabled={!canEdit} type="checkbox" checked={item.equipped} onChange={(event) => updateInventoryItem(item.id, (current) => ({ ...current, equipped: event.target.checked }))} />
                      已装备
                    </label>
                    <Button disabled={!canEdit} type="button" variant="ghost" className="px-3 text-red-300" aria-label={`删除物品 ${item.name}`} onClick={() => removeInventoryItem(item.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                    <div className="md:col-span-4">
                      <Field label="描述">
                        <Textarea disabled={!canEdit} maxLength={4_000} className="min-h-20 w-full" value={item.description} onChange={(event) => updateInventoryItem(item.id, (current) => ({ ...current, description: event.target.value }))} />
                      </Field>
                    </div>
                  </div>
                ))}
                {draft.inventory.length === 0 && <EmptyState>尚未添加物品。</EmptyState>}
                <Button disabled={!canEdit || draft.inventory.length >= 500} type="button" variant="secondary" className="justify-self-start" onClick={addInventoryItem}>
                  <Plus className="mr-2 h-4 w-4" />添加物品
                </Button>
              </div>
            </Section>

            <Section title="背景故事">
              <div className="grid gap-4 xl:grid-cols-2">
                {backgroundFields.map(([key, label]) => (
                  <Field key={key} label={label}>
                    <Textarea disabled={!canEdit} maxLength={4_000} value={draft.background[key]} onChange={(event) => editDraft((current) => ({ ...current, background: { ...current.background, [key]: event.target.value } }))} />
                  </Field>
                ))}
              </div>
            </Section>

            <Section title="调查员笔记">
              <Field label="自由记录">
                <Textarea disabled={!canEdit} maxLength={20_000} className="min-h-40" value={draft.notes} onChange={(event) => editDraft((current) => ({ ...current, notes: event.target.value }))} />
              </Field>
            </Section>

            <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-zinc-800 bg-panel/95 py-4 backdrop-blur">
              <Button onClick={() => void saveCharacter()} disabled={!canEdit || !dirty}>
                <Save className="mr-2 h-4 w-4" />保存并同步
              </Button>
              {dirty && canEdit && <span className="text-sm text-amber-200">有尚未同步的修改</span>}
              {error && <span className="max-w-2xl text-sm text-red-400">{error}</span>}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="mt-1 text-xs text-zinc-500">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function DerivedValue({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 font-mono text-xl text-zinc-100">{value}</div>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-5 text-sm text-zinc-500">{children}</div>;
}

function createSkill(): Skill {
  return {
    id: `skill-${crypto.randomUUID()}`,
    name: "新技能",
    baseValue: 0,
    value: 0,
    checked: false,
  };
}

function createInventoryItem(): InventoryItem {
  return {
    id: `item-${crypto.randomUUID()}`,
    name: "新物品",
    quantity: 1,
    description: "",
    equipped: false,
  };
}

function createCharacter(ownerPeerId: string, playerName: string): Coc7Character {
  const now = new Date().toISOString();
  const characteristics: Coc7Character["characteristics"] = {
    str: 50,
    con: 50,
    siz: 50,
    dex: 50,
    app: 50,
    int: 50,
    pow: 50,
    edu: 50,
    luck: 50,
  };
  const skills: Coc7Character["skills"] = [];
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    ownerPeerId,
    name: "新调查员",
    playerName,
    occupation: "",
    age: 25,
    residence: "",
    birthplace: "",
    characteristics,
    derived: deriveCoc7Stats({ characteristics, age: 25, skills }),
    skills,
    status: {
      temporaryInsanity: false,
      indefiniteInsanity: false,
      majorWound: false,
      dying: false,
      unconscious: false,
    },
    inventory: [],
    background: {
      personalDescription: "",
      ideologyAndBeliefs: "",
      significantPeople: "",
      meaningfulLocations: "",
      treasuredPossessions: "",
      traits: "",
      injuriesAndScars: "",
      phobiasAndManias: "",
      arcaneTomesSpellsAndArtifacts: "",
      encountersWithStrangeEntities: "",
    },
    notes: "",
    updatedAt: now,
    extensions: {},
  };
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  const finite = Number.isFinite(value) ? Math.trunc(value) : minimum;
  return Math.min(maximum, Math.max(minimum, finite));
}
