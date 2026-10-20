import { useRef, useState } from "react";
import { characterBriefingSchema, type CharacterBriefingV1, type ModulePackageV1, type RoomWorldStateV2 } from "@coc-room/protocol";
import type { RoomSessionV2 } from "../../network/RoomSessionV2";
import { currentCharacterBriefing } from "../../lib/character-creation-guidance";
import { Button } from "../ui/Button";
import { Input, Textarea } from "../ui/Field";

const limits = [
  ["characteristicBudget", "八项属性总点（不含幸运）"],
  ["characteristicMin", "单项属性下限（不含幸运）"],
  ["characteristicMax", "单项属性上限（不含幸运）"],
  ["skillBudget", "技能购点总预算（不含基础值）"],
  ["skillMax", "技能最终值上限"],
  ["occupationBudget", "本团固定职业预算（覆盖职业公式）"],
  ["interestBudget", "本团固定兴趣预算（覆盖智力 × 2）"],
] as const;

export function CharacterBriefingEditor({ session, world, modulePackage, disabled, onError }: {
  session: RoomSessionV2;
  world: RoomWorldStateV2;
  modulePackage?: ModulePackageV1;
  disabled?: boolean;
  onError?(message?: string): void;
}) {
  const [draft, setDraft] = useState<CharacterBriefingV1>(() => currentCharacterBriefing(world) ?? { text: "", recommendedSkills: [], skillPointMode: "occupation-interest", ...(world.activeModule ? { moduleId: world.activeModule.moduleId } : {}) });
  const [recommended, setRecommended] = useState(draft.recommendedSkills.join("、"));
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  if (!session.isHost) return null;
  const update = (next: Partial<CharacterBriefingV1>) => { setDraft((current) => ({ ...current, ...next })); setPreview(false); setNotice(""); };
  const publish = async () => {
    if (disabled || inFlight.current) return;
    inFlight.current = true; setBusy(true); onError?.(undefined);
    try {
      const briefing = characterBriefingSchema.parse({ ...draft, recommendedSkills: recommended.split(/[、,，\n]/u).map((item) => item.trim()).filter(Boolean) });
      await session.submitConfirmed({ type: "room.settings.updated", audience: { kind: "room" }, payload: { defaultVisibility: world.defaultVisibility, characterBriefing: briefing } });
      setPreview(false); setNotice("已发布，玩家的车卡页和 AI 草稿会使用这份公开要求。");
    } catch (error) { onError?.(`车卡说明未发布：${error instanceof Error ? error.message : String(error)}`); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <details id="room-character-briefing" className="mb-4 scroll-mt-4 rounded-lg border border-zinc-700 p-3" aria-label="发布本团车卡要求">
    <summary className="cursor-pointer text-sm text-brass">本团车卡说明与点数要求</summary>
    <div className="mt-3 grid gap-3">
      <p className="text-xs text-zinc-400">填写年代、公开委托、适合的人物背景与房规。玩家进房后即可据此车卡；空白限额表示未配置。</p>
      {modulePackage?.keeperGuide?.preparation && <Button variant="secondary" disabled={disabled || busy} onClick={() => update({ text: modulePackage.keeperGuide!.preparation!.playerBriefing.text })}>从主持引导填入公开草稿</Button>}
      <Textarea aria-label="本团公开车卡说明" maxLength={8000} value={draft.text} disabled={disabled || busy} onChange={(event) => update({ text: event.target.value })} placeholder="年代、身份、介入事件的理由、职业限制及其他房规" />
      <Input aria-label="本团推荐技能" maxLength={2000} value={recommended} disabled={disabled || busy} onChange={(event) => { setRecommended(event.target.value); setPreview(false); }} placeholder="推荐技能，用顿号分隔；仅作建议" />
      <label className="flex items-center gap-2 text-sm"><input aria-label="分别核算职业点与兴趣点" type="checkbox" disabled={disabled || busy} checked={Boolean(draft.skillPointMode)} onChange={(event) => update({ skillPointMode: event.target.checked ? "occupation-interest" : undefined })} />按职业点＋兴趣点分别核算</label>
      {draft.skillPointMode && <label className="flex items-center gap-2 text-xs"><input aria-label="允许初始克苏鲁神话购点" type="checkbox" disabled={disabled || busy} checked={Boolean(draft.allowMythos)} onChange={(event) => update({ allowMythos: event.target.checked })} />房规允许初始克苏鲁神话购点</label>}
      <details><summary className="cursor-pointer text-xs text-zinc-400">配置自动核算的房规</summary><div className="mt-2 grid gap-2 sm:grid-cols-2">{limits.map(([key, label]) => <label key={key} className="text-xs text-zinc-400">{label}<Input aria-label={label} type="number" min={0} disabled={disabled || busy} value={draft[key] ?? ""} onChange={(event) => update({ [key]: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>)}</div></details>
      <Button variant="secondary" disabled={disabled || busy} onClick={() => setPreview(true)}>预览本团要求</Button>
      {preview && <section aria-label="车卡要求公开预览" className="grid gap-2 rounded border border-brass/50 p-3">
        <p className="text-xs text-brass">所有玩家会看到</p><p className="whitespace-pre-wrap text-sm">{draft.text || "尚无背景说明"}</p>
        {limits.map(([key, label]) => draft[key] === undefined ? null : <p className="text-xs" key={key}>{label}：{draft[key]}</p>)}
        {recommended && <p className="text-xs">推荐技能：{recommended}</p>}
        {draft.skillPointMode && <p className="text-xs">职业点与兴趣点分别核算；兴趣预算默认为智力 × 2。{draft.allowMythos ? "允许初始克苏鲁神话购点。" : "不允许初始克苏鲁神话购点。"}</p>}
        <Button disabled={disabled || busy} onClick={() => void publish()}>确认发布给玩家</Button>
      </section>}
      {notice && <p role="status" className="text-xs text-emerald-300">{notice}</p>}
    </div>
  </details>;
}
