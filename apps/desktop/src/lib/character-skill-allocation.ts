import type { CharacterBriefingV1, Coc7Character, Coc7CreationPlan, Coc7Skill } from "@coc-room/protocol";

export const occupationFormulas: Array<[Coc7CreationPlan["occupationFormula"], string]> = [
  ["edu4", "教育 × 4"], ["edu2-str2", "教育 × 2 ＋ 力量 × 2"], ["edu2-dex2", "教育 × 2 ＋ 敏捷 × 2"],
  ["edu2-app2", "教育 × 2 ＋ 外貌 × 2"], ["edu2-pow2", "教育 × 2 ＋ 意志 × 2"], ["custom", "自定义职业预算"],
];

// Small starting profiles, not a complete occupation catalogue. Choice slots
// remain explicit; selecting a profile never spends points or erases skills.
// Sources: Chaosium investigator wiki (skill choices) and licensed Roll20
// Free Basic Rules, Step Four (occupation formula and credit range).
export const occupationProfiles = [
  { name: "作家", formula: "edu4" as const, creditMin: 9, creditMax: 30, skills: [["艺术/手艺（文学）", 5], ["历史", 5], ["图书馆使用", 20], ["外语", 1], ["母语", "edu"], ["心理学", 10], ["信用评级", 0]] as const, choices: "另选自然学或神秘学，并选一项符合人物经历的技能；为母语、外语填写具体语言。" },
  { name: "记者", formula: "edu4" as const, creditMin: 9, creditMax: 30, skills: [["艺术/手艺（摄影）", 5], ["历史", 5], ["图书馆使用", 20], ["母语", "edu"], ["心理学", 10], ["信用评级", 0]] as const, choices: "另选一项交涉技能（魅惑、话术、恐吓或说服），再选两项符合人物经历的技能；为母语填写具体语言。" },
  { name: "教授", formula: "edu4" as const, creditMin: 20, creditMax: 70, skills: [["图书馆使用", 20], ["外语", 1], ["母语", "edu"], ["心理学", 10], ["信用评级", 0]] as const, choices: "另选四项符合学科或人物经历的技能；为母语、外语填写具体语言。" },
  // https://roll20.net/compendium/coc/Doctor%20of%20Medicine
  { name: "医生", formula: "edu4" as const, creditMin: 30, creditMax: 80, skills: [["急救", 30], ["外语", 1, "拉丁语"], ["医学", 1], ["心理学", 10], ["科学", 1, "生物学"], ["科学", 1, "药学"], ["信用评级", 0]] as const, choices: "另选两项学术、时代或个人专长。时代改编或不同信用范围可改用自定义职业配置。" },
] as const;

type OccupationSkillSpec = readonly [string, number | "edu", string?];
function occupationSkillMatches(skill: Coc7Skill, [name, _base, specialization]: OccupationSkillSpec): boolean {
  const normalized = (text: string) => text.replace(/其他语言/gu, "外语").replace(/\s/gu, "").toLocaleLowerCase();
  const combined = skill.specialization ? `${skill.name}（${skill.specialization}）` : skill.name;
  return specialization ? normalized(combined) === normalized(`${name}（${specialization}）`) : normalized(skill.name) === normalized(name) || normalized(combined) === normalized(name);
}

export function enableSkillAllocation(character: Coc7Character): Coc7Character {
  if (character.creation) return character;
  return { ...character, creation: { occupationFormula: "custom", occupationSkillIds: [], allocations: Object.fromEntries(character.skills.map((skill) => [skill.id, { occupation: 0, interest: Math.max(0, skill.value - skill.baseValue) }])) } };
}

export function skillPointBudgets(character: Coc7Character, briefing?: CharacterBriefingV1) {
  const plan = character.creation;
  const attribute = plan?.occupationFormula.split("-")[1]?.slice(0, -1) as "str" | "dex" | "app" | "pow" | undefined;
  const calculated = plan?.occupationFormula === "edu4" ? character.characteristics.edu * 4
    : attribute ? character.characteristics.edu * 2 + character.characteristics[attribute] * 2 : undefined;
  return {
    occupation: briefing?.occupationBudget ?? (plan?.occupationFormula === "custom" ? plan.occupationBudget : calculated),
    interest: briefing?.interestBudget ?? plan?.interestBudget ?? character.characteristics.int * 2,
  };
}

export function auditSkillAllocation(character: Coc7Character, briefing?: CharacterBriefingV1) {
  const plan = character.creation;
  const budgets = skillPointBudgets(character, briefing);
  const issues: string[] = [];
  let occupationSpent = 0;
  let interestSpent = 0;
  if (!plan) {
    if (briefing?.skillPointMode) issues.push("本团按职业点与兴趣点分别核算，请先启用分配并确认职业公式与职业技能。");
    return { ...budgets, occupationSpent, interestSpent, issues };
  }
  if (budgets.occupation === undefined) issues.push("还没有职业点预算，请选择本职业公式或填写自定义预算。");
  if ((plan.creditMin ?? 0) > (plan.creditMax ?? 99)) issues.push("职业信用下限不能高于上限，请核对房规。");
  const profile = occupationProfiles.find((item) => item.name === plan.occupationProfile);
  if (profile) {
    const selected = character.skills.filter((skill) => plan.occupationSkillIds.includes(skill.id));
    const missing = profile.skills.filter((requirement) => !selected.some((skill) => occupationSkillMatches(skill, requirement)));
    if (missing.length) issues.push(`尚未选择职业要求的技能：${missing.map((requirement) => requirement.length > 2 ? `${requirement[0]}（${requirement[2]}）` : requirement[0]).join("、")}。若采用房规，可改为自定义职业配置。`);
    if (plan.occupationFormula !== profile.formula || plan.creditMin !== profile.creditMin || plan.creditMax !== profile.creditMax) issues.push(`${profile.name}配置的公式或信用范围与职业参考不符；请核对，采用房规时可改为自定义职业配置。`);
    if (selected.length !== 9) issues.push(`此职业需选定八项职业技能和信用评级；当前共选 ${selected.length} 项，${selected.length < 9 ? `还需 ${9 - selected.length} 项` : `多选 ${selected.length - 9} 项`}。`);
    if (profile.name === "记者" && !selected.some((skill) => ["魅惑", "话术", "恐吓", "说服"].includes(skill.name))) issues.push("记者还需选一项交涉技能：魅惑、话术、恐吓或说服。");
    if (profile.name === "作家" && !selected.some((skill) => ["自然学", "神秘学"].includes(skill.name))) issues.push("作家还需选择自然学或神秘学作为职业技能。");
  }
  const known = new Set(character.skills.map((skill) => skill.id));
  if (Object.keys(plan.allocations).some((id) => !known.has(id)) || plan.occupationSkillIds.some((id) => !known.has(id))) issues.push("分配记录引用了已删除的技能，请重新整理投入。");
  for (const skill of character.skills) {
    if (plan.occupationSkillIds.includes(skill.id) && ["母语", "外语", "其他语言"].includes(skill.name) && !skill.specialization?.trim()) issues.push(`请在${skill.name}的专攻中填写具体语言。`);
    const linkedBase = skill.baseSource === "edu" ? character.characteristics.edu : skill.baseSource === "half-dex" ? Math.floor(character.characteristics.dex / 2) : undefined;
    if (linkedBase !== undefined && skill.baseValue !== linkedBase) issues.push(`${skill.name}基础值 ${skill.baseValue} 与关联属性计算值 ${linkedBase} 不符，请核对基础值来源。`);
    const points = plan.allocations[skill.id] ?? { occupation: 0, interest: 0 };
    occupationSpent += points.occupation;
    interestSpent += points.interest;
    if (points.occupation && !plan.occupationSkillIds.includes(skill.id)) issues.push(`${skill.name}不是已选职业技能，请改用兴趣点或修正职业技能选择。`);
    const total = skill.baseValue + points.occupation + points.interest;
    if (total > 100) issues.push(`${skill.name}基础值与投入合计 ${total}，超出角色表上限 100。`);
    else if (skill.value !== total) issues.push(`${skill.name}当前值 ${skill.value} 与分配合计 ${total} 不符，请核对导入值或重新计算。`);
    if (!briefing?.allowMythos && /克苏鲁神话|cthulhu\s*mythos/iu.test(skill.name) && points.occupation + points.interest > 0) issues.push("克苏鲁神话不能在本次车卡中购点；需要 KP 明确允许后再投入。");
  }
  if (budgets.occupation !== undefined && occupationSpent > budgets.occupation) issues.push(`职业点超出 ${occupationSpent - budgets.occupation} 点，请减少职业投入。`);
  if (interestSpent > budgets.interest) issues.push(`兴趣点超出 ${interestSpent - budgets.interest} 点，请减少兴趣投入。`);
  const credit = character.skills.find((skill) => /^(信用评级|信用|credit rating)$/iu.test(skill.name));
  if (plan.creditMin !== undefined && (credit?.value ?? 0) < plan.creditMin) issues.push(`信用评级尚需 ${plan.creditMin - (credit?.value ?? 0)} 点才能达到职业下限 ${plan.creditMin}。`);
  if (plan.creditMax !== undefined && (credit?.value ?? 0) > plan.creditMax) issues.push(`信用评级超出职业上限 ${plan.creditMax}，请核对职业或房规。`);
  return { ...budgets, occupationSpent, interestSpent, issues };
}

export function recalculateAllocatedSkills(character: Coc7Character, skillId?: string): Coc7Character {
  if (!character.creation) return character;
  return { ...character, skills: character.skills.map((skill) => {
    if (skillId && skill.id !== skillId) return skill;
    const points = character.creation!.allocations[skill.id] ?? { occupation: 0, interest: 0 };
    return { ...skill, value: Math.min(100, skill.baseValue + points.occupation + points.interest) };
  }) };
}

/** Only explicitly linked bases follow attributes. Manual house-rule values and in-play growth stay separate. */
export function updateLinkedSkillBases(character: Coc7Character): Coc7Character {
  return { ...character, skills: character.skills.map((skill) => {
    if (!skill.baseSource) return skill;
    const baseValue = skill.baseSource === "edu" ? character.characteristics.edu : Math.floor(character.characteristics.dex / 2);
    const points = character.creation?.allocations[skill.id];
    const bought = character.creation ? (points?.occupation ?? 0) + (points?.interest ?? 0) : Math.max(0, skill.value - skill.baseValue);
    return { ...skill, baseValue, value: Math.min(100, baseValue + bought) };
  }) };
}

export function applyOccupationProfile(character: Coc7Character, profileName: string): Coc7Character {
  const profile = occupationProfiles.find((item) => item.name === profileName);
  if (!profile) return character;
  const enabled = enableSkillAllocation(character);
  const skills = [...enabled.skills];
  const ids: string[] = [];
  for (const requirement of profile.skills) {
    const [name, base, specialization] = requirement as OccupationSkillSpec;
    let skill = skills.find((item) => occupationSkillMatches(item, requirement));
    if (!skill) {
      const baseValue = base === "edu" ? character.characteristics.edu : base;
      skill = { id: `skill-${crypto.randomUUID()}`, name, ...(specialization ? { specialization } : {}), baseValue, value: baseValue, checked: false, ...(base === "edu" ? { baseSource: "edu" as const } : {}) };
      skills.push(skill);
    }
    ids.push(skill.id);
  }
  if (skills.length > 200) throw new Error("加入职业技能会超过 200 项，请先整理技能。");
  return { ...enabled, occupation: profile.name, skills, creation: { ...enabled.creation!, occupationProfile: profile.name, occupationFormula: profile.formula, occupationBudget: undefined, creditMin: profile.creditMin, creditMax: profile.creditMax, occupationSkillIds: ids } };
}

/** Preserve all final values. The keeper/player reviews the allocation, especially selectable occupation skills. */
export function allocateExistingSkillValues(character: Coc7Character, briefing?: CharacterBriefingV1): Coc7Character {
  if (!character.creation) return character;
  let remaining = skillPointBudgets(character, briefing).occupation ?? 0;
  const allocations: Coc7CreationPlan["allocations"] = {};
  const ordered = [...character.skills].sort((a, b) => Number(/信用|credit rating/iu.test(b.name)) - Number(/信用|credit rating/iu.test(a.name)));
  for (const skill of ordered) {
    const spent = Math.max(0, skill.value - skill.baseValue);
    const occupation = character.creation.occupationSkillIds.includes(skill.id) ? Math.min(remaining, spent) : 0;
    remaining -= occupation;
    allocations[skill.id] = { occupation, interest: spent - occupation };
  }
  return { ...character, creation: { ...character.creation, allocations } };
}
