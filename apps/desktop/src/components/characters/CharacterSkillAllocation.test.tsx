// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Coc7Character } from "@coc-room/protocol";
import { miniInvestigator } from "../../test/scenarios/mini-investigation";
import { CharacterCreationGuidance } from "./CharacterCreationGuidance";
import { CharacterSkillAllocationFields, CharacterSkillBudgetEditor } from "./CharacterSkillAllocation";

afterEach(cleanup);

function Harness() {
  const [character, setCharacter] = useState<Coc7Character>(structuredClone(miniInvestigator));
  const briefing = { text: "回应公开委托", recommendedSkills: [], skillPointMode: "occupation-interest" as const };
  return <><CharacterCreationGuidance character={character} briefing={briefing} /><CharacterSkillBudgetEditor character={character} briefing={briefing} onChange={setCharacter} />{character.skills.map((skill) => <section key={skill.id}><p aria-label={`${skill.name}最终值`}>{skill.value}</p><CharacterSkillAllocationFields character={character} skillId={skill.id} onChange={setCharacter} /></section>)}</>;
}

it("takes existing values into separate pools, supports a career's selectable skills, and recalculates totals without adding bases twice", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "按职业点＋兴趣点分配" }));
  fireEvent.change(screen.getByLabelText("职业起步配置"), { target: { value: "记者" } });
  expect(screen.getByLabelText("侦查最终值").textContent).toBe("60");
  expect(screen.getByText(/另选一项交涉技能/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText("侦查是职业技能"));
  fireEvent.click(screen.getByRole("button", { name: "按职业优先整理现有投入" }));
  expect((screen.getByLabelText("侦查职业投入") as HTMLInputElement).value).toBe("35");
  expect((screen.getByLabelText("侦查兴趣投入") as HTMLInputElement).value).toBe("0");
  expect(screen.getByLabelText("侦查最终值").textContent).toBe("60");
  fireEvent.change(screen.getByLabelText("侦查兴趣投入"), { target: { value: "10" } });
  expect(screen.getByLabelText("侦查最终值").textContent).toBe("70");
  expect(screen.getByText("兴趣点：10 / 140，剩余 130")).toBeTruthy();
  expect(screen.getByLabelText("车卡待修改项").textContent).toContain("信用评级尚需 9 点");
  fireEvent.change(screen.getByLabelText("信用评级职业投入"), { target: { value: "9" } });
  expect(screen.getByLabelText("车卡待修改项").textContent).toContain("记者还需选一项交涉技能");
  expect(screen.getByLabelText("车卡待修改项").textContent).toContain("填写具体语言");
  fireEvent.click(screen.getByRole("button", { name: "按房规自定义职业技能，保留现有投入" }));
  expect(screen.getByLabelText("车卡待修改项").textContent).not.toContain("记者还需选一项交涉技能");
  expect(screen.getByLabelText("车卡待修改项").textContent).toContain("填写具体语言");
  fireEvent.change(screen.getByLabelText("职业点公式"), { target: { value: "custom" } });
  fireEvent.change(screen.getByLabelText("自定义职业预算"), { target: { value: "0" } });
  expect(screen.getByLabelText("车卡待修改项").textContent).toContain("职业点超出 74 点");
});
