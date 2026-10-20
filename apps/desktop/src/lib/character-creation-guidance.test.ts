import { expect, it } from "vitest";
import { createRoomWorldStateV2 } from "@coc-room/protocol";
import { miniInvestigator } from "../test/scenarios/mini-investigation";
import { auditCharacterCreation, characterPromptWithBriefing, currentCharacterBriefing } from "./character-creation-guidance";

it("accounts for bought skill points without counting base values or luck, and gives correction amounts", () => {
  const character = { ...miniInvestigator, characteristics: { str: 50, con: 50, siz: 50, dex: 50, app: 50, int: 50, pow: 50, edu: 50, luck: 99 }, skills: [{ id: "skill-spot", name: "侦查", baseValue: 25, value: 80, checked: false }] };
  const audit = auditCharacterCreation(character, { text: "", recommendedSkills: ["侦查", "聆听"], characteristicBudget: 390, skillBudget: 50, skillMax: 75 });
  expect(audit.characteristicSpent).toBe(400);
  expect(audit.skillSpent).toBe(55);
  expect(audit.issues).toEqual(["八项属性超出 10 点，请降低属性。", "技能购点超出 5 点，请减少技能投入。", "侦查超出技能上限 75，请减少 5 点。"]);
  expect(audit.missingRecommended).toEqual(["聆听"]);
  expect(auditCharacterCreation(character).issues).toEqual([]);
});

it("uses only confirmed public guidance, and stops applying it after a module switch", () => {
  const briefing = { moduleId: "module-one", text: "调查一宗失踪案，适合记者。", recommendedSkills: [] };
  const world = { ...createRoomWorldStateV2(), characterBriefing: briefing, activeModule: { moduleId: "module-one", revision: 1, title: "调查" } };
  expect(currentCharacterBriefing(world)).toBe(briefing);
  expect(currentCharacterBriefing({ ...world, activeModule: { ...world.activeModule, moduleId: "module-two" } })).toBeUndefined();
  expect(JSON.parse(characterPromptWithBriefing("我想当记者", briefing))).toMatchObject({ playerConcept: "我想当记者", keeperConfirmedPublicBriefing: briefing });
  const withoutBrief = JSON.parse(characterPromptWithBriefing("原始构想"));
  expect(withoutBrief.playerConcept).toBe("原始构想");
  expect(withoutBrief.keeperConfirmedPublicBriefing).toBeUndefined();
  expect(withoutBrief.referenceOccupationProfiles.find((profile: { name: string }) => profile.name === "医生")).toMatchObject({ formula: "edu4", creditMin: 30, creditMax: 80 });
});
