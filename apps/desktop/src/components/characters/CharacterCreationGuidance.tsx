import type { CharacterBriefingV1, Coc7Character } from "@coc-room/protocol";
import { auditCharacterCreation } from "../../lib/character-creation-guidance";

export function CharacterCreationGuidance({ character, briefing }: { character: Coc7Character; briefing?: CharacterBriefingV1 }) {
  const audit = auditCharacterCreation(character, briefing);
  return <section id="character-group-guidance" aria-label="本团车卡要求与点数" className="rounded-xl border border-brass/40 bg-brass/5 p-4">
    <h2 className="font-semibold text-brass">先按本团要求准备调查员</h2>
    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-300">{briefing?.text || "KP 尚未发布公开背景与车卡要求。可以先写人物构想，点数方式与职业限制仍需和 KP 确认。"}</p>
    <div className="mt-3 grid gap-1 text-sm">
      <p>八项属性（不含幸运）：{audit.characteristicSpent}{briefing?.characteristicBudget !== undefined ? ` / ${briefing.characteristicBudget}，剩余 ${briefing.characteristicBudget - audit.characteristicSpent}` : " · 未配置总点限制"}</p>
      <p>技能购点（最终值减基础值）：{audit.skillSpent}{briefing?.skillBudget !== undefined ? ` / ${briefing.skillBudget}，剩余 ${briefing.skillBudget - audit.skillSpent}` : character.creation ? " · 下方分别核算职业点与兴趣点" : " · 未配置购点预算"}</p>
      {character.creation && <><p>职业点：{audit.allocation.occupationSpent} / {audit.allocation.occupation ?? "尚未配置"}{audit.allocation.occupation !== undefined ? `，剩余 ${audit.allocation.occupation - audit.allocation.occupationSpent}` : ""}</p><p>兴趣点：{audit.allocation.interestSpent} / {audit.allocation.interest}，剩余 {audit.allocation.interest - audit.allocation.interestSpent}</p></>}
    </div>
    {briefing?.recommendedSkills.length ? <p className="mt-2 text-xs text-zinc-400">推荐能力：{briefing.recommendedSkills.join("、")}{audit.missingRecommended.length ? `。尚未投入：${audit.missingRecommended.join("、")}（仅建议，可与队友分工）。` : "。"}</p> : null}
    {audit.issues.length > 0 && <ul aria-label="车卡待修改项" className="mt-3 list-inside list-disc text-sm text-amber-200">{audit.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
    <p className="mt-2 text-xs text-zinc-500">按已选职业公式、投入与本团限额核算；职业技能的可选项、年龄修正及其他文字房规仍需核对。基础值应填写本团采用的数值。</p>
  </section>;
}
