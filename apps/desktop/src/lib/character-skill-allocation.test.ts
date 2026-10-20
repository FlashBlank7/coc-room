import { expect, it } from "vitest";
import { coc7CharacterSchema, type Coc7Character } from "@coc-room/protocol";
import { miniInvestigator } from "../test/scenarios/mini-investigation";
import { allocateExistingSkillValues, applyOccupationProfile, auditSkillAllocation, enableSkillAllocation, recalculateAllocatedSkills, skillPointBudgets, updateLinkedSkillBases } from "./character-skill-allocation";

function character(): Coc7Character {
  const enabled = enableSkillAllocation(structuredClone(miniInvestigator));
  return { ...enabled, creation: { ...enabled.creation!, occupationFormula: "edu2-dex2", occupationSkillIds: [enabled.skills[0]!.id], allocations: { [enabled.skills[0]!.id]: { occupation: 25, interest: 10 }, [enabled.skills[1]!.id]: { occupation: 0, interest: 30 } } } };
}

it("keeps base values outside both pools, lets interest bolster occupation skills, and follows changed attributes", () => {
  const investigator = character();
  expect(auditSkillAllocation(investigator)).toMatchObject({ occupation: 250, interest: 140, occupationSpent: 25, interestSpent: 40, issues: [] });
  investigator.characteristics.dex = 40;
  investigator.characteristics.int = 50;
  expect(skillPointBudgets(investigator)).toEqual({ occupation: 210, interest: 100 });
  expect(skillPointBudgets(investigator, { text: "房规", recommendedSkills: [], occupationBudget: 300, interestBudget: 80 })).toEqual({ occupation: 300, interest: 80 });
});

it("reports each pool's overage, non-occupation spending, missing budgets and mythos purchase", () => {
  const investigator = character();
  investigator.creation!.occupationSkillIds = [];
  expect(auditSkillAllocation(investigator, { text: "", recommendedSkills: [], occupationBudget: 20, interestBudget: 30 }).issues).toEqual([
    "侦查不是已选职业技能，请改用兴趣点或修正职业技能选择。", "职业点超出 5 点，请减少职业投入。", "兴趣点超出 10 点，请减少兴趣投入。",
  ]);
  investigator.creation!.occupationFormula = "custom";
  expect(auditSkillAllocation(investigator).issues.join()).toContain("还没有职业点预算");
  investigator.skills[0]!.name = "克苏鲁神话";
  expect(auditSkillAllocation(investigator).issues.join()).toContain("需要 KP 明确允许");
  expect(auditSkillAllocation(investigator, { text: "", recommendedSkills: [], allowMythos: true }).issues.join()).not.toContain("需要 KP 明确允许");
});

it("adds a career starting profile without erasing work, keeps selectable skills explicit, and accounts for credit", () => {
  const initial = character();
  const investigator = applyOccupationProfile(initial, "记者");
  expect(investigator.skills.find((skill) => skill.id === initial.skills[0]!.id)!.value).toBe(60);
  expect(investigator.skills.find((skill) => skill.name === "母语")!.baseValue).toBe(65);
  expect(investigator.creation!.occupationSkillIds).not.toContain(initial.skills[0]!.id);
  expect(auditSkillAllocation(investigator).issues.join()).toContain("职业下限 9");
  expect(applyOccupationProfile(investigator, "记者").skills).toHaveLength(investigator.skills.length);
});

it("reassigns imported investments within the occupational budget without changing final values", () => {
  const investigator = character();
  investigator.creation!.occupationSkillIds = investigator.skills.map((skill) => skill.id);
  const result = allocateExistingSkillValues(investigator, { text: "", recommendedSkills: [], occupationBudget: 40 });
  expect(result.skills).toEqual(investigator.skills);
  expect(auditSkillAllocation(result)).toMatchObject({ occupationSpent: 40, interestSpent: 25, issues: [] });
  const parsed = coc7CharacterSchema.parse(JSON.parse(JSON.stringify(result)));
  expect(parsed.creation).toEqual(result.creation);
  expect(coc7CharacterSchema.safeParse({ ...result, creation: { ...result.creation, allocations: { phantom: { occupation: 1, interest: 0 } } } }).success).toBe(false);
});

it("does not hide overspending by clamping displayed skill values, or silently accept an imported mismatch", () => {
  const investigator = character();
  investigator.creation!.allocations[investigator.skills[0]!.id] = { occupation: 80, interest: 20 };
  const updated = recalculateAllocatedSkills(investigator);
  expect(updated.skills[0]!.value).toBe(100);
  expect(auditSkillAllocation(updated).issues.join()).toContain("合计 125");
  expect(auditSkillAllocation(investigator).issues.join()).toContain("合计 125");
});

it("keeps a standard occupation incomplete until its selectable skills and language are supplied", () => {
  let investigator = applyOccupationProfile(character(), "记者");
  expect(auditSkillAllocation(investigator).issues.join()).toContain("还需 3 项");
  investigator.skills.push({ id: "skill-persuade", name: "说服", baseValue: 10, value: 10, checked: false }, { id: "skill-listen", name: "聆听", baseValue: 20, value: 20, checked: false });
  const credit = investigator.skills.find((skill) => skill.name === "信用评级")!;
  investigator.creation!.occupationSkillIds = investigator.skills.map((skill) => skill.id);
  investigator.creation!.allocations[credit.id] = { occupation: 9, interest: 0 };
  investigator = recalculateAllocatedSkills(investigator);
  expect(auditSkillAllocation(investigator).issues).toEqual(["请在母语的专攻中填写具体语言。"]);
  investigator.skills.find((skill) => skill.name === "母语")!.specialization = "日语";
  expect(auditSkillAllocation(investigator).issues).toEqual([]);
});

it("updates linked language and dodge bases while preserving investments and explicit house-rule bases", () => {
  let investigator = applyOccupationProfile(character(), "记者");
  const language = investigator.skills.find((skill) => skill.name === "母语")!;
  investigator.creation!.allocations[language.id] = { occupation: 5, interest: 0 };
  investigator.skills.push({ id: "skill-dodge", name: "闪避", baseValue: 30, baseSource: "half-dex", value: 40, checked: false });
  investigator.creation!.allocations["skill-dodge"] = { occupation: 0, interest: 10 };
  investigator.characteristics.edu = 70;
  investigator.characteristics.dex = 40;
  investigator = updateLinkedSkillBases(investigator);
  expect(investigator.skills.find((skill) => skill.id === language.id)).toMatchObject({ baseValue: 70, value: 75 });
  expect(investigator.skills.find((skill) => skill.id === "skill-dodge")).toMatchObject({ baseValue: 20, value: 30 });
  expect(investigator.skills[0]!).toMatchObject({ baseValue: 25, value: 60 });
});

it("checks language and linked bases for AI and custom occupations as well as built-in profiles", () => {
  const investigator = character();
  investigator.skills[0] = { ...investigator.skills[0]!, name: "母语", baseValue: 25, baseSource: "edu" };
  investigator.creation!.origin = "ai";
  expect(auditSkillAllocation(investigator).issues).toEqual(["请在母语的专攻中填写具体语言。", "母语基础值 25 与关联属性计算值 65 不符，请核对基础值来源。"]);
});

it("keeps a doctor's required specializations distinct and rejects an invented standard credit range", () => {
  const doctor = applyOccupationProfile(character(), "医生");
  expect(doctor.creation).toMatchObject({ occupationProfile: "医生", occupationFormula: "edu4", creditMin: 30, creditMax: 80 });
  expect(doctor.skills.filter((skill) => skill.name === "科学").map((skill) => skill.specialization)).toEqual(["生物学", "药学"]);
  expect(applyOccupationProfile(doctor, "医生").skills).toHaveLength(doctor.skills.length);
  doctor.creation!.creditMin = 9;
  doctor.creation!.creditMax = 45;
  expect(auditSkillAllocation(doctor).issues.join()).toContain("医生配置的公式或信用范围与职业参考不符");
  const pharmacy = doctor.skills.find((skill) => skill.specialization === "药学")!;
  doctor.creation!.occupationSkillIds = doctor.creation!.occupationSkillIds.filter((id) => id !== pharmacy.id);
  expect(auditSkillAllocation(doctor).issues.join()).toContain("科学（药学）");
});
