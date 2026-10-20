import { useEffect, useRef, useState } from "react";
import type { CheckDifficulty, RoomWorldStateV2 } from "@coc-room/protocol";
import type { RoomSessionV2 } from "../../../network/RoomSessionV2";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Field";
import { tableCharacters } from "../../../lib/table-seating";

export interface DirectCheckPreset { skill: string; difficulty: CheckDifficulty }

export function DirectCheckComposer({ session, world, preset, disabled, onError }: {
  session: RoomSessionV2;
  world: RoomWorldStateV2;
  preset?: DirectCheckPreset;
  disabled?: boolean;
  onError?(message?: string): void;
}) {
  const characters = tableCharacters(world);
  const [characterId, setCharacterId] = useState("");
  const character = characters.find((item) => item.id === characterId) ?? (characters.length === 1 ? characters[0] : undefined);
  const characterSelect = useRef<HTMLSelectElement>(null);
  const [skill, setSkill] = useState(preset?.skill ?? "");
  const [difficulty, setDifficulty] = useState<CheckDifficulty>(preset?.difficulty ?? "regular");
  const [target, setTarget] = useState<number>();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => { if (preset) { setSkill(preset.skill); setDifficulty(preset.difficulty); } }, [preset]);
  useEffect(() => { if (preset) characterSelect.current?.focus(); }, [preset, characters.length]);
  useEffect(() => {
    const attributes = { 力量: "str", 体质: "con", 体型: "siz", 敏捷: "dex", 外貌: "app", 智力: "int", 灵感: "int", 意志: "pow", 教育: "edu", 知识: "edu", 幸运: "luck" } as const;
    const characteristic = attributes[skill as keyof typeof attributes] ?? skill.toLowerCase();
    const value = character?.skills.find((entry) => entry.name === skill)?.value
      ?? character?.characteristics[characteristic as keyof typeof character.characteristics];
    setTarget(value !== undefined && value > 0 ? value : undefined);
  }, [character, skill]);
  if (!session.isHost) return null;
  const send = async () => {
    if (!character || !target || !skill.trim() || disabled || inFlight.current) return;
    inFlight.current = true; setBusy(true); onError?.(undefined);
    try {
      const requestId = crypto.randomUUID();
      await session.submitConfirmed({ type: "check.requested", audience: { kind: "room" }, payload: {
        requestId, characterId: character.id, characterName: character.name, skillName: skill.trim(), proposedTarget: target,
        reason: reason.trim() || `进行${skill.trim()}检定`,
      } });
      await session.submitConfirmed({ type: "check.authorized", audience: { kind: "room" }, payload: {
        requestId, skillName: skill.trim(), target, requiredDifficulty: difficulty, bonusDice: 0, penaltyDice: 0, note: "KP 发起检定",
      } });
      setReason("");
    } catch (error) { onError?.(`检定未完全发出，请查看待裁定列表：${error instanceof Error ? error.message : String(error)}`); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <details id="keeper-direct-check" open={preset ? true : undefined} className="mb-4 rounded-lg border border-zinc-700 p-3">
    <summary className="cursor-pointer text-sm text-brass">KP 直接发起检定</summary>
    <div className="mt-3 grid gap-2">
      <p className="text-xs text-zinc-400">已在语音中说清行动时，选角色并发出检定即可。以下内容所有人可见。</p>
      {characters.length === 0 ? <div className="rounded border border-amber-800/50 p-3"><p className="text-sm text-amber-200">{preset ? `要发起${preset.skill}检定，` : ""}请先在座位上放置调查员角色卡。</p><a href="#room-table-seats" className="mt-2 inline-block text-sm text-brass underline">去设置座位和角色卡</a></div> : <>
      <label className="text-xs">调查员<select ref={characterSelect} aria-label="直接检定角色" className="ml-2 rounded border border-zinc-700 bg-zinc-900 p-2" value={character?.id ?? ""} onChange={(event) => setCharacterId(event.target.value)}><option value="" disabled>选择要掷骰的调查员…</option>{characters.map((item) => { const seat = [...(world.tableSeats?.values() ?? [])].find((entry) => entry.characterId === item.id); return <option key={item.id} value={item.id}>{seat ? `${seat.name} · ` : ""}{item.name}</option>; })}</select></label>
      <label className="text-xs">检定项目<Input aria-label="直接检定技能" maxLength={160} value={skill} onChange={(event) => setSkill(event.target.value)} placeholder="技能或属性名称" list="direct-check-skills" /></label>
      <datalist id="direct-check-skills">{character?.skills.map((entry) => <option key={entry.id} value={entry.name} />)}</datalist>
      <label className="text-xs">检定值<Input aria-label="直接检定数值" disabled={!character} type="number" min={1} max={100} value={target ?? ""} onChange={(event) => setTarget(event.target.value === "" ? undefined : Math.min(100, Math.max(1, Math.trunc(Number(event.target.value) || 1))))} /></label>
      {character && target === undefined && <p className="text-xs text-amber-300">角色卡中未找到可用数值，请确认检定项目或手动填写。</p>}
      <select aria-label="直接检定难度" value={difficulty} className="h-9 rounded bg-zinc-900 px-2 text-sm" onChange={(event) => setDifficulty(event.target.value as CheckDifficulty)}><option value="regular">常规</option><option value="hard">困难</option><option value="extreme">极难</option></select>
      <Input aria-label="直接检定公开说明" maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="公开行动说明（可选；已口头说明可直接发出）" />
      <Button disabled={disabled || busy || !character || !target || !skill.trim()} onClick={() => void send()}>发给调查员掷骰</Button>
      </>}
    </div>
  </details>;
}
