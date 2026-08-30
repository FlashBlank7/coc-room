// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  type RoomEventProposalV2,
  type RoomWorldStateV2,
  type SeatV2,
} from "@coc-room/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CheckNegotiationV2,
  KeeperModuleWorkbenchV2,
  PublicClueBoardV2,
} from "../../components/room/v2/InvestigationWorkspaceV2";
import type { RoomSessionV2 } from "../../network/RoomSessionV2";
import { RoomViewV2 } from "../../views/RoomViewV2";
import {
  commitMiniInvestigationProposal,
  createMiniInvestigationWorld,
  miniHostSeat,
  miniInvestigation,
  miniInvestigator,
  miniModule,
  miniPlayerSeat,
  miniRoomRecord,
} from "../scenarios/mini-investigation";

afterEach(cleanup);

describe("segmented task journey: no-map investigation (not browser E2E)", () => {
  it("carries one human play loop from KP scene framing through a shared clue", async () => {
    let world = createMiniInvestigationWorld();

    // 1. The KP reads private prep, writes a deliberately public opening, and
    // presents it without first creating or manipulating a map.
    const sceneSubmit = vi.fn().mockResolvedValue("confirmed");
    render(
      <KeeperModuleWorkbenchV2
        modulePackage={miniModule}
        world={world}
        session={mockSession(world, miniHostSeat, sceneSubmit)}
      />,
    );
    fireEvent.change(screen.getByLabelText("玩家可见的开场描述"), {
      target: { value: miniInvestigation.publicOpening },
    });
    fireEvent.click(screen.getByRole("button", { name: "向所有人呈现这个场景" }));

    await waitFor(() => expect(sceneSubmit).toHaveBeenCalledTimes(2));
    const sceneProposal = proposalAt(sceneSubmit, 0, "entity.upserted");
    const focusProposal = proposalAt(sceneSubmit, 1, "scene.focused");
    expect(sceneProposal).toMatchObject({
      audience: { kind: "room" },
      payload: {
        entity: {
          kind: "scene",
          name: "后台唱片室",
          description: miniInvestigation.publicOpening,
        },
      },
    });
    expect(focusProposal.payload.sceneEntityId).toBe(sceneProposal.payload.entity.entityId);
    expect(serializedCalls(sceneSubmit)).not.toContain(miniInvestigation.secrets.sceneSynopsis);
    expect(serializedCalls(sceneSubmit)).not.toContain(miniInvestigation.secrets.keeperNotes);

    world = commitMiniInvestigationProposal(world, miniHostSeat, sceneProposal);
    world = commitMiniInvestigationProposal(world, miniHostSeat, focusProposal);
    world = commitMiniInvestigationProposal(world, miniPlayerSeat, {
      type: "character.updated",
      audience: { kind: "room" },
      payload: { character: miniInvestigator },
    });
    cleanup();

    // 2. A fresh player-room mount reconstructs the current situation from
    // durable world state. No private module prose is available in that view.
    const playerRoomSession = mockSession(world, miniPlayerSeat, vi.fn());
    const renderPlayerRoom = () => render(
      <RoomViewV2
        room={miniRoomRecord("player")}
        session={playerRoomSession}
        views={[]}
        world={world}
        seats={[miniHostSeat, miniPlayerSeat]}
        paths={{}}
        authenticationState="authenticated"
        setConnectionError={vi.fn()}
        onLeave={vi.fn()}
      />,
    );
    const firstMount = renderPlayerRoom();
    assertPublicCurrentSituation();
    firstMount.unmount();
    renderPlayerRoom();
    assertPublicCurrentSituation();
    cleanup();

    // 3. The player describes intent and chooses a value from their character
    // sheet; the UI, not the player, supplies the numeric target to the KP.
    const requestSubmit = vi.fn().mockResolvedValue("confirmed");
    render(
      <CheckNegotiationV2
        world={world}
        session={mockSession(world, miniPlayerSeat, requestSubmit)}
      />,
    );
    expect(screen.queryByLabelText("检定建议目标")).toBeNull();
    fireEvent.change(screen.getByLabelText("行动目标"), {
      target: { value: "确认唱片机是否被人动过" },
    });
    fireEvent.change(screen.getByLabelText("你想怎么做"), {
      target: { value: miniInvestigation.intendedAction },
    });
    fireEvent.change(screen.getByLabelText("使用技能或属性"), {
      target: { value: "skill:skill-spot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交行动，请 KP 裁定" }));

    await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));
    const requestProposal = proposalAt(requestSubmit, 0, "check.requested");
    expect(requestProposal).toMatchObject({
      audience: { kind: "room" },
      payload: {
        characterId: miniInvestigator.id,
        characterName: miniInvestigator.name,
        skillName: "侦查",
        proposedTarget: 60,
        reason: miniInvestigation.intendedAction,
        goal: "确认唱片机是否被人动过",
        approach: miniInvestigation.intendedAction,
        suggestedSkillName: "侦查",
      },
    });
    world = commitMiniInvestigationProposal(world, miniPlayerSeat, requestProposal);
    cleanup();

    // 4. The KP authorizes the proposed sheet value and the requesting player
    // receives one executable action with exactly that authorization.
    const authorizeSubmit = vi.fn().mockResolvedValue("confirmed");
    render(
      <RoomViewV2
        room={miniRoomRecord("host")}
        session={mockSession(world, miniHostSeat, authorizeSubmit)}
        views={[]}
        world={world}
        seats={[miniHostSeat, miniPlayerSeat]}
        paths={{}}
        authenticationState="authenticated"
        setConnectionError={vi.fn()}
        onLeave={vi.fn()}
      />,
    );
    const currentSituation = screen.getByLabelText("当前情境");
    const currentAction = screen.getByLabelText("当前行动");
    const liveStory = screen.getByRole("heading", { name: "正在发生" }).closest("section") as HTMLElement;
    expect(screen.getByRole("heading", { name: "需要你裁定的行动 · 1" })).toBeTruthy();
    expect(Boolean(currentSituation.compareDocumentPosition(currentAction) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(currentAction.compareDocumentPosition(liveStory) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(screen.getByText(miniInvestigation.intendedAction)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "需要检定" }));
    fireEvent.click(screen.getByRole("button", { name: "需要普通检定" }));

    await waitFor(() => expect(authorizeSubmit).toHaveBeenCalledTimes(1));
    const authorizationProposal = proposalAt(authorizeSubmit, 0, "check.authorized");
    expect(authorizationProposal).toMatchObject({
      audience: { kind: "room" },
      payload: {
        requestId: requestProposal.payload.requestId,
        skillName: "侦查",
        target: 60,
        requiredDifficulty: "regular",
        bonusDice: 0,
        penaltyDice: 0,
      },
    });
    world = commitMiniInvestigationProposal(world, miniHostSeat, authorizationProposal);
    cleanup();

    const rollDice = vi.fn().mockResolvedValue("roll-command");
    render(
      <RoomViewV2
        room={miniRoomRecord("player")}
        session={mockSession(world, miniPlayerSeat, vi.fn(), rollDice)}
        views={[]}
        world={world}
        seats={[miniHostSeat, miniPlayerSeat]}
        paths={{}}
        authenticationState="authenticated"
        setConnectionError={vi.fn()}
        onLeave={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "KP 已允许你掷骰" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "掷骰：侦查（60）" }));
    await waitFor(() => expect(rollDice).toHaveBeenCalledWith({
      expression: "1d100",
      reason: `侦查：${miniInvestigation.intendedAction}`,
      bonusDice: 0,
      penaltyDice: 0,
      target: 60,
      requiredDifficulty: "regular",
      checkRequestId: requestProposal.payload.requestId,
    }));
    cleanup();

    // 5. KP publication puts the player-facing clue directly in the shared
    // case file. "关注" is optional personal organization, not possession.
    const clueSubmit = vi.fn().mockResolvedValue("confirmed");
    render(
      <KeeperModuleWorkbenchV2
        modulePackage={miniModule}
        world={world}
        session={mockSession(world, miniHostSeat, clueSubmit)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "公开到调查案卷" }));

    await waitFor(() => expect(clueSubmit).toHaveBeenCalledTimes(1));
    const clueProposal = proposalAt(clueSubmit, 0, "artifact.upserted");
    expect(clueProposal).toMatchObject({
      audience: { kind: "room" },
      payload: {
        artifact: {
          kind: "clue",
          title: "倒放的曲序",
          description: "",
          body: miniInvestigation.publicClueText,
        },
      },
    });
    expect(serializedCalls(clueSubmit)).not.toContain(miniInvestigation.secrets.clueMeaning);
    world = commitMiniInvestigationProposal(world, miniHostSeat, clueProposal);
    cleanup();

    const focusSubmit = vi.fn().mockResolvedValue("confirmed");
    const clueView = render(
      <PublicClueBoardV2
        world={world}
        session={mockSession(world, miniPlayerSeat, focusSubmit)}
      />,
    );
    const sharedCaseFile = screen.getByLabelText("调查案卷");
    expect(screen.getByRole("button", { name: "全部线索" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(sharedCaseFile).getByText("倒放的曲序")).toBeTruthy();
    expect(within(sharedCaseFile).getByText(miniInvestigation.publicClueText)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "我的重点" }));
    expect(screen.getByText("我的重点还是空的。")).toBeTruthy();
    expect(screen.getByText(/遇到值得追查的内容时点“加入我的线索栏”/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看全部线索" }));

    fireEvent.click(screen.getByRole("button", { name: "加入我的线索栏" }));
    await waitFor(() => expect(focusSubmit).toHaveBeenCalledTimes(1));
    const personalFocusProposal = proposalAt(focusSubmit, 0, "clue.claimed");
    expect(personalFocusProposal).toMatchObject({
      audience: { kind: "room" },
      payload: {
        artifactId: clueProposal.payload.artifact.artifactId,
        characterId: miniInvestigator.id,
        characterName: miniInvestigator.name,
      },
    });
    world = commitMiniInvestigationProposal(world, miniPlayerSeat, personalFocusProposal);

    clueView.rerender(
      <PublicClueBoardV2
        world={world}
        session={mockSession(world, miniPlayerSeat, focusSubmit)}
      />,
    );
    expect(within(screen.getByLabelText("调查案卷")).getAllByText(miniInvestigation.publicClueText)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "我的重点" }));
    const personalCaseFile = screen.getByLabelText("我的重点列表");
    expect(within(personalCaseFile).getByText("倒放的曲序")).toBeTruthy();
    expect(within(personalCaseFile).getByText(miniInvestigation.publicClueText)).toBeTruthy();
    expect(within(screen.getByLabelText("调查案卷")).getAllByText(miniInvestigation.publicClueText)).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "移出我的重点" }));
    await waitFor(() => expect(focusSubmit).toHaveBeenCalledTimes(2));
    const removeFocusProposal = proposalAt(focusSubmit, 1, "clue.unclaimed");
    expect(removeFocusProposal).toMatchObject({
      audience: { kind: "room" },
      payload: {
        artifactId: clueProposal.payload.artifact.artifactId,
        characterId: miniInvestigator.id,
        characterName: miniInvestigator.name,
      },
    });
    world = commitMiniInvestigationProposal(world, miniPlayerSeat, removeFocusProposal);
    clueView.rerender(
      <PublicClueBoardV2
        world={world}
        session={mockSession(world, miniPlayerSeat, focusSubmit)}
      />,
    );
    expect(screen.getByText("我的重点还是空的。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "移出我的重点" })).toBeNull();
  });
});

function mockSession(
  world: RoomWorldStateV2,
  localSeat: SeatV2,
  submitConfirmed: ReturnType<typeof vi.fn>,
  rollDice: ReturnType<typeof vi.fn> = vi.fn(),
): RoomSessionV2 {
  return {
    world,
    localSeat,
    isHost: localSeat.role === "host",
    isAuthenticated: true,
    submitConfirmed,
    rollDice,
  } as unknown as RoomSessionV2;
}

function proposalAt<Type extends RoomEventProposalV2["type"]>(
  mock: ReturnType<typeof vi.fn>,
  index: number,
  type: Type,
): Extract<RoomEventProposalV2, { type: Type }> {
  const proposal = mock.mock.calls[index]?.[0] as RoomEventProposalV2 | undefined;
  expect(proposal?.type).toBe(type);
  return proposal as Extract<RoomEventProposalV2, { type: Type }>;
}

function serializedCalls(mock: ReturnType<typeof vi.fn>): string {
  return JSON.stringify(mock.mock.calls);
}

function assertPublicCurrentSituation(): void {
  const currentSituation = screen.getByLabelText("当前情境");
  expect(within(currentSituation).getByText("后台唱片室")).toBeTruthy();
  expect(within(currentSituation).getByText(miniInvestigation.publicOpening)).toBeTruthy();
  expect(screen.getByRole("heading", { name: "你想怎么做？" })).toBeTruthy();
  expect(document.body.textContent).not.toContain(miniInvestigation.secrets.sceneSynopsis);
  expect(document.body.textContent).not.toContain(miniInvestigation.secrets.keeperNotes);
  expect(document.body.textContent).not.toContain(miniInvestigation.secrets.clueMeaning);
}
