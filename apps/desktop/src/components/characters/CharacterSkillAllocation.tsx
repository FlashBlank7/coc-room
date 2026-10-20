import { useState } from "react";
import type { CharacterBriefingV1, Coc7Character, Coc7CreationPlan } from "@coc-room/protocol";
import { allocateExistingSkillValues, applyOccupationProfile, enableSkillAllocation, occupationFormulas, occupationProfiles, recalculateAllocatedSkills } from "../../lib/character-skill-allocation";
import { Button } from "../ui/Button";
import { Input } from "../ui/Field";

type Props = { character: Coc7Character; briefing?: CharacterBriefingV1; disabled?: boolean; onChange(character: Coc7Character): void };

export function CharacterSkillBudgetEditor({ character, briefing, disabled, onChange }: Props) {
  const [error, setError] = useState("");
  const plan = character.creation;
  const update = (changes: Partial<Coc7CreationPlan>) => onChange({ ...character, creation: { ...plan!, ...changes, ...(["occupationFormula", "creditMin", "creditMax"].some((key) => Object.hasOwn(changes, key)) ? { occupationProfile: undefined } : {}) } });
  return <section aria-label="职业与兴趣分配设置" className="mb-4 grid gap-3 rounded border border-brass/30 p-3 text-sm">
    {!plan ? <><p>职业点只投向职业技能；兴趣点也可以补强职业技能。先确认职业，再由系统分别算账。</p><Button disabled={disabled} variant="secondary" onClick={() => onChange(enableSkillAllocation(character))}>按职业点＋兴趣点分配</Button></> : <>
      <p>属性变化后预算会自动重算。当前技能值＝基础值＋职业投入＋兴趣投入；未用完的点数会显示为剩余，不强制全部花完。</p>
      {plan.origin === "ai" && <p className="text-xs text-amber-200">职业公式、信用范围和职业技能来自 AI 草稿，可在这里按本团采用的职业设定与房规调整。</p>}
      <label>职业起步配置<select aria-label="职业起步配置" className="ml-2 rounded bg-zinc-900 p-2" disabled={disabled} value="" onChange={(event) => {
        try { onChange(applyOccupationProfile(character, event.target.value)); setError(""); } catch (cause) { setError(String(cause)); }
      }}><option value="">选择后加入技能，保留已有数值</option>{occupationProfiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name}</option>)}</select></label>
      {occupationProfiles.filter((profile) => profile.name === plan.occupationProfile).map((profile) => <p key={profile.name} className="text-xs text-amber-200">{profile.choices}在下方为这些技能勾选“职业技能”。</p>)}
      {plan.occupationProfile && <Button disabled={disabled} variant="ghost" onClick={() => update({ occupationProfile: undefined })}>按房规自定义职业技能，保留现有投入</Button>}
      <label>职业点公式<select aria-label="职业点公式" className="ml-2 rounded bg-zinc-900 p-2" disabled={disabled} value={plan.occupationFormula} onChange={(event) => update({ occupationFormula: event.target.value as Coc7CreationPlan["occupationFormula"] })}>{occupationFormulas.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {plan.occupationFormula === "custom" && <label>自定义职业预算<Input aria-label="自定义职业预算" disabled={disabled || briefing?.occupationBudget !== undefined} type="number" min={0} max={10000} value={plan.occupationBudget ?? ""} onChange={(event) => update({ occupationBudget: optionalInteger(event.target.value, 10000) })} /></label>}
      <details><summary className="cursor-pointer text-xs text-zinc-400">本角色的房规与信用范围</summary><div className="mt-2 grid gap-2 sm:grid-cols-3">
        <label>兴趣点预算（留空为智力 × 2）<Input aria-label="角色兴趣点预算" disabled={disabled || briefing?.interestBudget !== undefined} type="number" min={0} max={10000} value={plan.interestBudget ?? ""} onChange={(event) => update({ interestBudget: optionalInteger(event.target.value, 10000) })} /></label>
        <label>职业信用下限<Input aria-label="职业信用下限" disabled={disabled} type="number" min={0} max={99} value={plan.creditMin ?? ""} onChange={(event) => update({ creditMin: optionalInteger(event.target.value, 99) })} /></label>
        <label>职业信用上限<Input aria-label="职业信用上限" disabled={disabled} type="number" min={0} max={99} value={plan.creditMax ?? ""} onChange={(event) => update({ creditMax: optionalInteger(event.target.value, 99) })} /></label>
      </div><p className="mt-2 text-xs text-zinc-500">房间发布的固定预算优先；职业选择、信用范围和个人房规会随角色卡给 KP 查看。</p></details>
      <Button disabled={disabled} variant="secondary" onClick={() => onChange(allocateExistingSkillValues(character, briefing))}>按职业优先整理现有投入</Button>
      <p className="text-xs text-zinc-500">此操作保留技能最终值，优先把已选职业技能的购点计入职业预算，余下计入兴趣点。只调整点数归属，不自动分配剩余点数。</p>
      <Button disabled={disabled} variant="ghost" onClick={() => onChange(recalculateAllocatedSkills(character))}>按分配重新计算技能值</Button>
      {!briefing?.skillPointMode && <Button disabled={disabled} variant="ghost" onClick={() => { const { creation: _plan, ...rest } = character; onChange(rest); }}>改为直接填写技能值</Button>}
    </>}
    {error && <p role="alert" className="text-amber-200">{error}</p>}
  </section>;
}

export function CharacterSkillAllocationFields({ character, skillId, disabled, onChange }: Props & { skillId: string }) {
  const plan = character.creation;
  const skill = character.skills.find((item) => item.id === skillId);
  if (!plan || !skill) return null;
  const points = plan.allocations[skillId] ?? { occupation: 0, interest: 0 };
  const update = (key: "occupation" | "interest", value: string) => onChange(recalculateAllocatedSkills({ ...character, creation: { ...plan, allocations: { ...plan.allocations, [skillId]: { ...points, [key]: optionalInteger(value, 100) ?? 0 } } } }, skillId));
  return <div aria-label={`分配：${skill.name}`} className="grid gap-2 border-t border-zinc-800 pt-2 md:col-span-2 xl:col-span-6 sm:grid-cols-3">
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" aria-label={`${skill.name}是职业技能`} disabled={disabled} checked={plan.occupationSkillIds.includes(skillId)} onChange={(event) => onChange({ ...character, creation: { ...plan, occupationSkillIds: event.target.checked ? [...plan.occupationSkillIds, skillId] : plan.occupationSkillIds.filter((id) => id !== skillId) } })} />职业技能</label>
    <label className="text-xs">职业投入<Input aria-label={`${skill.name}职业投入`} disabled={disabled} type="number" min={0} max={100} value={points.occupation} onChange={(event) => update("occupation", event.target.value)} /></label>
    <label className="text-xs">兴趣投入<Input aria-label={`${skill.name}兴趣投入`} disabled={disabled} type="number" min={0} max={100} value={points.interest} onChange={(event) => update("interest", event.target.value)} /></label>
  </div>;
}

function optionalInteger(value: string, maximum: number): number | undefined {
  return value === "" ? undefined : Math.min(maximum, Math.max(0, Math.trunc(Number(value) || 0)));
}
