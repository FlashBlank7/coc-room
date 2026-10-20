import type { CharacterBriefingV1, Coc7Character, RoomWorldStateV2 } from "@coc-room/protocol";
import { auditSkillAllocation, occupationProfiles } from "./character-skill-allocation";

export function currentCharacterBriefing(world?: RoomWorldStateV2): CharacterBriefingV1 | undefined {
  const briefing = world?.characterBriefing;
  return briefing && (!briefing.moduleId || briefing.moduleId === world?.activeModule?.moduleId) ? briefing : undefined;
}

export function auditCharacterCreation(character: Coc7Character, rules?: CharacterBriefingV1) {
  const attributes = Object.entries(character.characteristics).filter(([key]) => key !== "luck");
  const characteristicSpent = attributes.reduce((sum, [, value]) => sum + value, 0);
  const skillSpent = character.skills.reduce((sum, skill) => sum + Math.max(0, skill.value - skill.baseValue), 0);
  const issues: string[] = [];
  if (rules?.characteristicBudget !== undefined && characteristicSpent > rules.characteristicBudget) issues.push(`八项属性超出 ${characteristicSpent - rules.characteristicBudget} 点，请降低属性。`);
  const labels: Record<string, string> = { str: "力量", con: "体质", siz: "体型", dex: "敏捷", app: "外貌", int: "智力", pow: "意志", edu: "教育" };
  for (const [key, value] of attributes) {
    if (rules?.characteristicMin !== undefined && value < rules.characteristicMin) issues.push(`${labels[key]}低于本团下限 ${rules.characteristicMin}，还需 ${rules.characteristicMin - value} 点。`);
    if (rules?.characteristicMax !== undefined && value > rules.characteristicMax) issues.push(`${labels[key]}超出本团上限 ${rules.characteristicMax}，请减少 ${value - rules.characteristicMax} 点。`);
  }
  if (rules?.skillBudget !== undefined && skillSpent > rules.skillBudget) issues.push(`技能购点超出 ${skillSpent - rules.skillBudget} 点，请减少技能投入。`);
  for (const skill of character.skills) {
    if (skill.value < skill.baseValue) issues.push(`${skill.name}低于基础值，请核对基础值或最终值。`);
    if (rules?.skillMax !== undefined && skill.value > rules.skillMax) issues.push(`${skill.name}超出技能上限 ${rules.skillMax}，请减少 ${skill.value - rules.skillMax} 点。`);
  }
  const missingRecommended = rules?.recommendedSkills.filter((name) => !character.skills.some((skill) => skill.name === name && skill.value > skill.baseValue)) ?? [];
  const allocation = auditSkillAllocation(character, rules);
  issues.push(...allocation.issues);
  return { characteristicSpent, skillSpent, issues, missingRecommended, allocation };
}

/** Public briefing only. Never give the character model a module package, keeper notes, or source. */
export function characterPromptWithBriefing(prompt: string, briefing?: CharacterBriefingV1): string {
  return JSON.stringify({ playerConcept: prompt, ...(briefing ? { keeperConfirmedPublicBriefing: briefing } : {}), referenceOccupationProfiles: occupationProfiles,
    guidance: "按本团公开要求生成可修改的角色草稿。职业对应参考配置时，在 creation.occupationProfile 中选择该配置，遵守参考公式、信用范围、必选技能与可选项；显示职业名可符合时代，不因此擅改信用范围。房规明确要求不同配置时设为 null 并保留说明。未配置的点数限制不得声称已通过；技能购点为最终值减基础值，八项属性总点不含幸运。职业点仅投职业技能，兴趣点可补职业技能；完整分配以车卡页核算为准。不要从模组名称推断秘密剧情。" });
}
