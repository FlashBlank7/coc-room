// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RoomEventProposalV2 } from "@coc-room/protocol";
import type { RoomSessionV2 } from "../../../network/RoomSessionV2";
import { commitMiniInvestigationProposal, createMiniInvestigationWorld, miniHostSeat, miniInvestigator, miniPlayerSeat } from "../../../test/scenarios/mini-investigation";
import { DirectCheckComposer } from "./DirectCheckComposer";
import { CheckNegotiationV2 } from "./InvestigationWorkspaceV2";

afterEach(cleanup);

it("points to table setup instead of showing an empty investigator and missing-stat form", () => {
  const session = { isHost: true, localSeat: miniHostSeat } as RoomSessionV2;
  render(<DirectCheckComposer session={session} world={createMiniInvestigationWorld()} preset={{ skill: "知识", difficulty: "regular" }} />);
  expect(screen.queryByLabelText("直接检定角色")).toBeNull();
  expect(screen.queryByLabelText("直接检定数值")).toBeNull();
  expect(screen.getByRole("link", { name: "去设置座位和角色卡" }).getAttribute("href")).toBe("#room-table-seats");
});

it("requires a named investigator when several cards are available and reads Know from EDU without extra narration", async () => {
  let world = commitMiniInvestigationProposal(createMiniInvestigationWorld(), miniPlayerSeat, { type: "character.updated", audience: { kind: "room" }, payload: { character: miniInvestigator } });
  world = commitMiniInvestigationProposal(world, miniHostSeat, { type: "character.updated", audience: { kind: "room" }, payload: { character: { ...miniInvestigator, id: "another-investigator", name: "另一位调查员", characteristics: { ...miniInvestigator.characteristics, edu: 80 } } } });
  const submitConfirmed = vi.fn(async (proposal: RoomEventProposalV2) => { world = commitMiniInvestigationProposal(world, miniHostSeat, proposal); return "accepted"; });
  render(<DirectCheckComposer world={world} session={{ isHost: true, localSeat: miniHostSeat, submitConfirmed } as unknown as RoomSessionV2} preset={{ skill: "知识", difficulty: "regular" }} />);
  expect((screen.getByLabelText("直接检定角色") as HTMLSelectElement).value).toBe("");
  expect((screen.getByRole("button", { name: "发给调查员掷骰" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("直接检定角色"), { target: { value: "another-investigator" } });
  expect((screen.getByLabelText("直接检定技能") as HTMLInputElement).value).toBe("知识");
  expect((screen.getByLabelText("直接检定数值") as HTMLInputElement).value).toBe("80");
  fireEvent.click(screen.getByRole("button", { name: "发给调查员掷骰" }));
  await waitFor(() => expect(world.checkAuthorizations.size).toBe(1));
  expect([...world.checkRequests.values()][0]).toMatchObject({ characterId: "another-investigator", reason: "进行知识检定" });
});

it("turns a keeper instruction into an authorized roll on the player's card without a player form submission", async () => {
  let world = commitMiniInvestigationProposal(createMiniInvestigationWorld(), miniPlayerSeat, { type: "character.updated", audience: { kind: "room" }, payload: { character: miniInvestigator } });
  const submitConfirmed = vi.fn(async (proposal: RoomEventProposalV2) => { world = commitMiniInvestigationProposal(world, miniHostSeat, proposal); return "accepted"; });
  const session = { isHost: true, submitConfirmed, localSeat: miniHostSeat } as unknown as RoomSessionV2;
  const view = render(<DirectCheckComposer world={world} session={session} preset={{ skill: miniInvestigator.skills[0]!.name, difficulty: "hard" }} />);
  const skill = miniInvestigator.skills[0]!;
  expect((screen.getByLabelText("直接检定数值") as HTMLInputElement).value).toBe(String(skill.value));
  fireEvent.change(screen.getByLabelText("直接检定公开说明"), { target: { value: "检查夹层" } });
  fireEvent.click(screen.getByRole("button", { name: "发给调查员掷骰" }));
  fireEvent.click(screen.getByRole("button", { name: "发给调查员掷骰" }));
  await waitFor(() => expect(world.checkAuthorizations.size).toBe(1));
  expect(submitConfirmed).toHaveBeenCalledTimes(2);
  expect([...world.checkAuthorizations.values()][0]).toMatchObject({ requesterSeatId: miniPlayerSeat.seatId, target: skill.value, requiredDifficulty: "hard" });
  view.unmount();
  const playerSession = { isHost: false, localSeat: miniPlayerSeat } as unknown as RoomSessionV2;
  render(<CheckNegotiationV2 world={world} session={playerSession} />);
  expect(screen.getByRole("button", { name: `掷骰：${skill.name}（${skill.value}）` })).toBeTruthy();
});
