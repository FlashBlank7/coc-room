// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  createRoomWorldStateV2,
  type AssetDescriptorV1,
  type BoardV1,
  type Coc7Character,
  type ModulePackageV1,
  type RoomArtifactV2,
  type RoomEntityV2,
} from "@coc-room/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RoomSessionV2 } from "../../../network/RoomSessionV2";
import { BOARD_EXTERNAL_DROP_MIME } from "./board-constants";
import {
  CheckNegotiationV2,
  KeeperModuleWorkbenchV2,
  PublicClueBoardV2,
} from "./InvestigationWorkspaceV2";
import { detectSceneEntriesV2 } from "./investigation-workspace-helpers";

afterEach(cleanup);

describe("immersive V2 investigation workspace", () => {
  it("lets KP write a missing NPC introduction on the spot, recover it after navigation, and publish only that text", async () => {
    const world = createRoomWorldStateV2("room-inline-npc-draft");
    const modulePackage = moduleFixture();
    const npc = modulePackage.npcs[0]!;
    npc.playerDescription = undefined;
    const active = entity("scene-inline-npc", "scene", "后台唱片室", { sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "scene", id: "scene-source" } });
    (world.entities as Map<string, RoomEntityV2>).set(active.entityId, active);
    (world as { activeSceneEntityId?: string }).activeSceneEntityId = active.entityId;
    const submitConfirmed = vi.fn().mockResolvedValue("confirmed");
    const session = { isHost: true, world, localSeat: { seatId: "seat-host", role: "host" }, submitConfirmed } as unknown as RoomSessionV2;
    const view = render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} session={session} />);
    const label = `玩家可见介绍：${npc.name}`;
    const input = screen.getByLabelText(label) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(input.value).toBe("");
    expect(screen.getByRole("button", { name: "让 NPC 在当前情境登场" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(input, { target: { value: "她抱着一把三味线，抬头望向你们。" } });
    expect(submitConfirmed).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "让 NPC 在当前情境登场" }).hasAttribute("disabled")).toBe(false);
    // Wait for the actual local repository write, then navigate away and back.
    const { getRepository } = await import("../../../data/repository");
    const repository = await getRepository();
    const key = `room-publication:${JSON.stringify([world.roomId, modulePackage.moduleId, modulePackage.revision])}`;
    await waitFor(async () => expect(await repository.getSetting(key)).toContain("三味线"));
    view.unmount();
    render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} session={session} />);
    await waitFor(() => expect((screen.getByLabelText(label) as HTMLTextAreaElement).value).toBe("她抱着一把三味线，抬头望向你们。"));
    fireEvent.click(screen.getByRole("button", { name: "让 NPC 在当前情境登场" }));
    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledOnce());
    expect(submitConfirmed.mock.calls[0]![0].payload.entity.description).toBe("她抱着一把三味线，抬头望向你们。");
    expect(JSON.stringify(submitConfirmed.mock.calls)).not.toContain(npc.motivation);
    expect(JSON.stringify(submitConfirmed.mock.calls)).not.toContain(npc.description);
    expect(modulePackage.npcs[0]!.playerDescription).toBeUndefined();
  });

  it("previews and presents only selected public scene companions, without copying keeper references", async () => {
    const world = createRoomWorldStateV2("room-batch-preview");
    const modulePackage = moduleFixture();
    const submitConfirmed = vi.fn(async () => "published");
    const session = { isHost: true, world, localSeat: { seatId: "seat-host", role: "host" }, submitConfirmed } as unknown as RoomSessionV2;
    render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} session={session} />);
    await waitFor(() => expect((screen.getByLabelText("玩家可见介绍：剧院后门") as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("玩家可见的开场描述"), { target: { value: "雨中的剧院门口。" } });
    fireEvent.change(screen.getByLabelText("玩家可见介绍：剧院后门"), { target: { value: "锈蚀的铁门上挂着一道崭新的锁。" } });
    fireEvent.click(screen.getByText("准备一起登场的内容"));
    fireEvent.click(screen.getByRole("checkbox", { name: "剧院后门" }));
    fireEvent.click(screen.getByRole("button", { name: "预览一起登场" }));
    const preview = screen.getByLabelText("成组呈现公开预览");
    expect(preview.textContent).toContain("锈蚀的铁门上挂着一道崭新的锁");
    expect(preview.textContent).not.toContain("KP 知道门锁已被调包");
    expect(preview.textContent).not.toContain("沉默的演员");
    expect(submitConfirmed).not.toHaveBeenCalled();
    fireEvent.click(within(preview).getByRole("button", { name: "确认呈现场景与 1 项内容" }));
    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledTimes(3));
    const payloads = JSON.stringify(submitConfirmed.mock.calls);
    expect(payloads).toContain("雨中的剧院门口");
    expect(payloads).not.toContain("KP 知道门锁已被调包");
    expect(payloads).not.toContain("KP 秘密动机");
    expect(payloads).not.toContain("沉默的演员");
  });

  it("lets KP revise an already published introduction without resetting its scene associations", async () => {
    const world = createRoomWorldStateV2("room-edit-published-npc");
    const modulePackage = moduleFixture();
    const npc = modulePackage.npcs[0]!;
    const active = entity("scene-edit-published", "scene", "后台唱片室", { sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "scene", id: "scene-source" } });
    const published = { ...entity("npc-edit-published", "npc", npc.name, { sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "npc", id: npc.id }, presentedInSceneEntityIds: [active.entityId] }), description: "你们已经见过的演员。" };
    for (const item of [active, published]) (world.entities as Map<string, RoomEntityV2>).set(item.entityId, item);
    (world as { activeSceneEntityId?: string }).activeSceneEntityId = active.entityId;
    const submitConfirmed = vi.fn(async (proposal) => {
      if (proposal.type === "entity.upserted") (world.entities as Map<string, RoomEntityV2>).set(proposal.payload.entity.entityId, proposal.payload.entity);
      return "confirmed";
    });
    const session = { isHost: true, world, localSeat: { seatId: "seat-host", role: "host" }, submitConfirmed } as unknown as RoomSessionV2;
    render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} session={session} />);
    const input = screen.getByLabelText(`玩家可见介绍：${npc.name}`) as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(input.value).toBe(published.description);
    fireEvent.change(input, { target: { value: "演员将一封信递给你们。" } });
    expect(submitConfirmed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "更新玩家可见介绍" }));
    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledOnce());
    expect(world.entities.get(published.entityId)).toMatchObject({ revision: published.revision + 1, description: "演员将一封信递给你们。", data: { presentedInSceneEntityIds: [active.entityId] } });
    expect(screen.getByRole("button", { name: "已在当前情境公开" }).hasAttribute("disabled")).toBe(true);
  });
  it("detects a character token entering a scene zone without publishing hidden module text", () => {
    const world = createRoomWorldStateV2("room-immersive");
    const scene = entity("scene-room", "scene", "唱片室", { sourceRef: { id: "scene-source", kind: "scene" } });
    const character = entity("entity-reporter", "character", "林默", { characterId: "character-reporter", ownerSeatId: "seat-player" });
    (world.entities as Map<string, RoomEntityV2>).set(scene.entityId, scene);
    (world.entities as Map<string, RoomEntityV2>).set(character.entityId, character);
    const board = mapBoard();
    board.items = [
      item("item-scene", scene.entityId, { x: 800, y: 450 }, { width: 420, height: 260 }, true),
      item("item-character", character.entityId, { x: 800, y: 450 }, { width: 130, height: 130 }, false),
    ];

    const entries = detectSceneEntriesV2(world, board);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.characters[0]?.entity.name).toBe("林默");
    expect(JSON.stringify(entries)).not.toContain("keeperNotes");
  });

  it("lets the player execute exactly the parameters authorized by KP", async () => {
    const world = createRoomWorldStateV2("room-check");
    const character = investigator();
    (world.latestCharacters as Map<string, Coc7Character>).set(character.id, character);
    (world.checkRequests as Map<string, never>).set("check-spot", {
      requestId: "check-spot",
      characterId: character.id,
      characterName: character.name,
      skillName: "侦查",
      proposedTarget: 60,
      reason: "检查唱片机夹层",
      requesterSeatId: "seat-player",
      requestedAt: "2026-08-29T00:00:00.000Z",
    } as never);
    (world.checkAuthorizations as Map<string, never>).set("check-spot", {
      requestId: "check-spot",
      target: 60,
      requiredDifficulty: "hard",
      bonusDice: 1,
      penaltyDice: 0,
      note: "可以",
      requesterSeatId: "seat-player",
      authorizedAt: "2026-08-29T00:00:01.000Z",
    } as never);
    const rollDice = vi.fn().mockResolvedValue("command-roll");
    const session = { isHost: false, localSeat: { seatId: "seat-player", role: "player", displayName: "玩家" }, rollDice, submitConfirmed: vi.fn(), isAuthenticated: true } as unknown as RoomSessionV2;

    render(<CheckNegotiationV2 world={world} session={session} />);
    expect(screen.getByRole("heading", { name: "KP 已允许你掷骰" })).toBeTruthy();

    // The player must see the full terms of the ruling — the risk note and
    // the bonus/penalty dice — before deciding to roll, not after the result.
    const readyCard = screen.getByLabelText("KP 已允许的检定");
    expect(readyCard.textContent).toContain("KP 已允许：侦查 60 · 困难 · 1 个奖励骰");
    expect(readyCard.textContent).toContain("KP 补充：可以");

    fireEvent.click(screen.getByRole("button", { name: "掷骰：侦查（60）" }));

    await waitFor(() => expect(rollDice).toHaveBeenCalledWith({
      expression: "1d100",
      reason: "侦查：检查唱片机夹层",
      bonusDice: 1,
      penaltyDice: 0,
      target: 60,
      requiredDifficulty: "hard",
      checkRequestId: "check-spot",
    }));
  });

  it("keeps the roll locked through the relay round-trip and ignores a second click", async () => {
    const world = regularReadyCheckWorld();
    let settleRoll: ((commandId: string) => void) | undefined;
    const rollDice = vi.fn().mockImplementation(() => new Promise<string>((resolve) => { settleRoll = resolve; }));
    const session = { isHost: false, localSeat: { seatId: "seat-player", role: "player", displayName: "玩家" }, rollDice, submitConfirmed: vi.fn(), isAuthenticated: true } as unknown as RoomSessionV2;

    const view = render(<CheckNegotiationV2 world={world} session={session} />);
    const rollButton = screen.getByRole("button", { name: "掷骰：侦查（60）" });
    fireEvent.click(rollButton);
    // A frantic double-click during the same tick must not send a second
    // command — the host would reject it as an "already rolled" conflict.
    fireEvent.click(rollButton);
    expect(rollDice).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "正在掷骰…" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "放弃这次检定" }).hasAttribute("disabled")).toBe(true);

    // For a player, rollDice resolves when the command reaches the transport,
    // not when the dice.result lands. The button must stay locked after that.
    settleRoll?.("command-roll");
    await waitFor(() => expect(screen.getByRole("button", { name: "正在掷骰…" }).hasAttribute("disabled")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "正在掷骰…" }));
    expect(rollDice).toHaveBeenCalledTimes(1);

    // Once the relayed dice.result resolves the authorization, the card leaves
    // the ready list entirely.
    const resolvedWorld = regularReadyCheckWorld({ resolvedByEventId: "event-roll", resolvedSuccess: true });
    view.rerender(<CheckNegotiationV2 world={resolvedWorld} session={session} />);
    expect(screen.queryByRole("button", { name: "正在掷骰…" })).toBeNull();
    expect(screen.queryByLabelText("KP 已允许的检定")).toBeNull();
  });

  it("re-enables the roll and shows the reason when the submit itself fails", async () => {
    const world = regularReadyCheckWorld();
    const rollDice = vi.fn().mockRejectedValue(new Error("房主当前离线，房间已暂停"));
    const onError = vi.fn();
    const session = { isHost: false, localSeat: { seatId: "seat-player", role: "player", displayName: "玩家" }, rollDice, submitConfirmed: vi.fn(), isAuthenticated: true } as unknown as RoomSessionV2;

    render(<CheckNegotiationV2 world={world} session={session} onError={onError} />);
    fireEvent.click(screen.getByRole("button", { name: "掷骰：侦查（60）" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("房主当前离线，房间已暂停"));
    expect(screen.getByRole("button", { name: "掷骰：侦查（60）" }).hasAttribute("disabled")).toBe(false);
  });

  it("lets the player walk away from an authorized regular check before rolling", async () => {
    const world = regularReadyCheckWorld();
    const submitConfirmed = vi.fn().mockResolvedValue("check-abandoned");
    const session = { isHost: false, localSeat: { seatId: "seat-player", role: "player", displayName: "玩家" }, rollDice: vi.fn(), submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<CheckNegotiationV2 world={world} session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "放弃这次检定" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledWith({
      type: "check.closed",
      audience: { kind: "room" },
      payload: {
        requestId: "check-spot",
        outcome: "cancelled",
        note: "调查员在掷骰前放弃了这次检定，换一种做法继续调查。",
      },
    }));
  });

  it("lets KP withdraw a mistaken ruling that is still waiting for the roll", async () => {
    const world = regularReadyCheckWorld();
    const submitConfirmed = vi.fn().mockResolvedValue("ruling-withdrawn");
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<CheckNegotiationV2 world={world} session={session} />);
    const waitingRow = screen.getByLabelText("等待掷骰：林默");
    expect(waitingRow.textContent).toContain("林默 · 侦查 60 · 困难 · 1 个奖励骰");
    fireEvent.click(within(waitingRow).getByRole("button", { name: "撤回裁定" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledWith({
      type: "check.closed",
      audience: { kind: "room" },
      payload: {
        requestId: "check-spot",
        outcome: "cancelled",
        note: "KP 撤回了这次裁定；请重新提交行动，再由 KP 重新裁定。",
      },
    }));
  });

  it("does not show the waiting-for-roll ruling list once the dice have landed", () => {
    const world = regularReadyCheckWorld({ resolvedByEventId: "event-roll", resolvedSuccess: true });
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, submitConfirmed: vi.fn(), isAuthenticated: true } as unknown as RoomSessionV2;

    render(<CheckNegotiationV2 world={world} session={session} />);

    expect(screen.queryByLabelText("等待掷骰：林默")).toBeNull();
    expect(screen.queryByRole("button", { name: "撤回裁定" })).toBeNull();
  });

  it("translates a raw host-side reducer race into an understandable reason", async () => {
    const world = createRoomWorldStateV2("room-host-reducer-error");
    const character = investigator();
    (world.latestCharacters as Map<string, Coc7Character>).set(character.id, character);
    (world.checkRequests as Map<string, never>).set("check-obvious", {
      requestId: "check-obvious",
      characterId: character.id,
      characterName: character.name,
      skillName: "侦查",
      proposedTarget: 60,
      reason: "查看桌面上没有遮挡的信件",
      requesterSeatId: "seat-player",
      requestedAt: "2026-08-29T00:00:00.000Z",
      audience: { kind: "room" },
    } as never);
    // The host commits to its local reducer, so a race (the investigator just
    // withdrew) rejects with a raw English error rather than a classified one.
    const submitConfirmed = vi.fn().mockRejectedValue(new Error("check check-obvious was closed"));
    const onError = vi.fn();
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<CheckNegotiationV2 world={world} session={session} onError={onError} />);
    fireEvent.change(screen.getByLabelText("直接结果：林默"), { target: { value: "信件就在桌面上。" } });
    fireEvent.click(screen.getByRole("button", { name: "无需掷骰，直接给出结果" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("这项行动刚刚被撤回或已经结束，不需要再处理它。"));
  });

  it("falls back to showing an unknown host-side failure instead of hiding it", async () => {
    const world = createRoomWorldStateV2("room-host-unknown-error");
    const character = investigator();
    (world.latestCharacters as Map<string, Coc7Character>).set(character.id, character);
    (world.checkRequests as Map<string, never>).set("check-odd", {
      requestId: "check-odd",
      characterId: character.id,
      characterName: character.name,
      skillName: "侦查",
      proposedTarget: 60,
      reason: "翻查抽屉",
      requesterSeatId: "seat-player",
      requestedAt: "2026-08-29T00:00:00.000Z",
      audience: { kind: "room" },
    } as never);
    const submitConfirmed = vi.fn().mockRejectedValue(new Error("sequencer storage exploded"));
    const onError = vi.fn();
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<CheckNegotiationV2 world={world} session={session} onError={onError} />);
    fireEvent.change(screen.getByLabelText("直接结果：林默"), { target: { value: "抽屉里只有旧报纸。" } });
    fireEvent.click(screen.getByRole("button", { name: "无需掷骰，直接给出结果" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("刚才的操作没有完成：sequencer storage exploded"));
  });

  it("allows another ordinary action without requiring a separate narration record", () => {
    const world = pushCheckWorld("successful");
    const session = { isHost: false, localSeat: { seatId: "seat-player", role: "player", displayName: "玩家" }, submitConfirmed: vi.fn(), isAuthenticated: true } as unknown as RoomSessionV2;

    const view = render(<CheckNegotiationV2 world={world} session={session} waitingForKeeperOutcome />);

    expect(screen.getByRole("heading", { name: "检定已完成，可以继续行动" })).toBeTruthy();
    expect(screen.getByText(/无需等待补写记录/)).toBeTruthy();
    expect(screen.getByLabelText("你想怎么做")).toBeTruthy();

    view.rerender(<CheckNegotiationV2 world={world} session={session} waitingForKeeperOutcome={false} />);
    expect(screen.getByRole("heading", { name: "你想怎么做？" })).toBeTruthy();
    expect(screen.getByLabelText("你想怎么做")).toBeTruthy();
  });

  it("asks KP about an intended action using the value on the character sheet", async () => {
    const world = createRoomWorldStateV2("room-check-request");
    const character = investigator();
    (world.latestCharacters as Map<string, Coc7Character>).set(character.id, character);
    const submitConfirmed = vi.fn().mockResolvedValue("check-request");
    const session = { isHost: false, localSeat: { seatId: "seat-player", role: "player", displayName: "玩家" }, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<CheckNegotiationV2 world={world} session={session} />);
    expect(screen.queryByLabelText("检定建议目标")).toBeNull();
    fireEvent.change(screen.getByLabelText("行动目标"), { target: { value: "确认唱片机是否被动过" } });
    fireEvent.change(screen.getByLabelText("你想怎么做"), { target: { value: "贴近唱片机检查拆卸痕迹" } });
    fireEvent.change(screen.getByLabelText("使用技能或属性"), { target: { value: "skill:skill-spot" } });
    expect(screen.getByRole("heading", { name: "你想怎么做？" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "提交行动，请 KP 裁定" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledTimes(1));
    expect(submitConfirmed.mock.calls[0]?.[0]).toMatchObject({
      type: "check.requested",
      audience: { kind: "room" },
      payload: {
        characterId: character.id,
        characterName: character.name,
        skillName: "侦查",
        proposedTarget: 60,
        reason: "贴近唱片机检查拆卸痕迹",
        goal: "确认唱片机是否被动过",
        approach: "贴近唱片机检查拆卸痕迹",
        suggestedSkillName: "侦查",
      },
    });
  });

  it("lets KP correct the target and set difficulty, risk note, and a penalty die", async () => {
    const world = createRoomWorldStateV2("room-check-ruling");
    const character = investigator();
    (world.latestCharacters as Map<string, Coc7Character>).set(character.id, character);
    (world.checkRequests as Map<string, never>).set("check-ruling", {
      requestId: "check-ruling",
      characterId: character.id,
      characterName: character.name,
      skillName: "侦查",
      proposedTarget: 60,
      reason: "在暴雨里辨认远处的人影",
      requesterSeatId: "seat-player",
      requestedAt: "2026-08-29T00:00:00.000Z",
      audience: { kind: "room" },
    } as never);
    const submitConfirmed = vi.fn().mockResolvedValue("check-authorization");
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<CheckNegotiationV2 world={world} session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "需要检定" }));
    fireEvent.change(screen.getByLabelText("检定目标：林默"), { target: { value: "55" } });
    fireEvent.change(screen.getByLabelText("奖惩骰：林默"), { target: { value: "-1" } });
    fireEvent.change(screen.getByLabelText("KP 裁定说明：林默"), { target: { value: "雨势会遮挡视线" } });
    fireEvent.click(screen.getByRole("button", { name: "需要困难检定" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledWith({
      type: "check.authorized",
      audience: { kind: "room" },
      payload: {
        requestId: "check-ruling",
        skillName: "侦查",
        target: 55,
        requiredDifficulty: "hard",
        bonusDice: 0,
        penaltyDice: 1,
        note: "雨势会遮挡视线",
      },
    }));
  });

  it("lets KP close an action as narrative progress without creating a fake roll", async () => {
    const world = createRoomWorldStateV2("room-check-no-roll");
    const character = investigator();
    (world.latestCharacters as Map<string, Coc7Character>).set(character.id, character);
    (world.checkRequests as Map<string, never>).set("check-obvious", {
      requestId: "check-obvious",
      characterId: character.id,
      characterName: character.name,
      skillName: "侦查",
      proposedTarget: 60,
      reason: "查看桌面上没有遮挡的信件",
      requesterSeatId: "seat-player",
      requestedAt: "2026-08-29T00:00:00.000Z",
      audience: { kind: "room" },
    } as never);
    const submitConfirmed = vi.fn().mockResolvedValue("check-closed");
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<CheckNegotiationV2 world={world} session={session} />);
    fireEvent.change(screen.getByLabelText("直接结果：林默"), { target: { value: "信件就在桌面上，林默直接读到了署名和约见时间。" } });
    fireEvent.click(screen.getByRole("button", { name: "无需掷骰，直接给出结果" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledWith({
      type: "check.closed",
      audience: { kind: "room" },
      payload: {
        requestId: "check-obvious",
        outcome: "no-roll",
        note: "信件就在桌面上，林默直接读到了署名和约见时间。",
      },
    }));
  });

  it("lets a player withdraw only their own pending action", async () => {
    const world = createRoomWorldStateV2("room-check-cancel");
    const character = investigator();
    (world.latestCharacters as Map<string, Coc7Character>).set(character.id, character);
    (world.checkRequests as Map<string, never>).set("check-withdraw", {
      requestId: "check-withdraw",
      characterId: character.id,
      characterName: character.name,
      skillName: "侦查",
      proposedTarget: 60,
      reason: "冒险撬开地下室的门",
      requesterSeatId: "seat-player",
      requestedAt: "2026-08-29T00:00:00.000Z",
      audience: { kind: "room" },
    } as never);
    const submitConfirmed = vi.fn().mockResolvedValue("check-cancelled");
    const session = { isHost: false, localSeat: { seatId: "seat-player", role: "player", displayName: "玩家" }, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<CheckNegotiationV2 world={world} session={session} />);
    expect(screen.getByRole("heading", { name: "行动已交给 KP" })).toBeTruthy();
    expect(screen.queryByLabelText("你想怎么做")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "撤回这个行动" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledWith({
      type: "check.closed",
      audience: { kind: "room" },
      payload: {
        requestId: "check-withdraw",
        outcome: "cancelled",
        note: "调查员撤回了行动申请。",
      },
    }));
  });

  it("offers one pushed check after the player's first failed roll and submits the new method", async () => {
    const world = pushCheckWorld("failed");
    const submitConfirmed = vi.fn().mockResolvedValue("push-requested");
    const session = { isHost: false, localSeat: { seatId: "seat-player", role: "player", displayName: "玩家" }, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<CheckNegotiationV2 world={world} session={session} />);

    expect(screen.getByRole("heading", { name: "第一次检定失败了" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("强推的新做法"), { target: { value: "不再撬锁；我拆下铰链销，从门背面拨锁。" } });
    fireEvent.click(screen.getByRole("button", { name: "换一种做法申请强推" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledTimes(1));
    expect(submitConfirmed.mock.calls[0]?.[0]).toMatchObject({
      type: "check.requested",
      audience: { kind: "room" },
      payload: {
        characterId: "character-reporter",
        characterName: "林默",
        skillName: "侦查",
        proposedTarget: 60,
        reason: "不再撬锁；我拆下铰链销，从门背面拨锁。",
        pushOfRequestId: "check-original",
      },
    });
  });

  it.each([
    { mode: "successful" as const, label: "the first roll succeeded" },
    { mode: "unfinished" as const, label: "the first roll is not finished" },
    { mode: "pending-push" as const, label: "a pushed method is already waiting for KP" },
    { mode: "failed-push" as const, label: "the pushed roll has already failed" },
    { mode: "closed-original" as const, label: "the original request has a terminal closure" },
  ])("does not offer another push when $label", ({ mode }) => {
    const world = pushCheckWorld(mode);
    const session = { isHost: false, localSeat: { seatId: "seat-player", role: "player", displayName: "玩家" }, submitConfirmed: vi.fn(), isAuthenticated: true } as unknown as RoomSessionV2;

    render(<CheckNegotiationV2 world={world} session={session} />);

    expect(screen.queryByLabelText("强推的新做法")).toBeNull();
    expect(screen.queryByRole("button", { name: "换一种做法申请强推" })).toBeNull();
  });

  it("allows a different pushed method when KP rejected the previous proposal before authorization", () => {
    const world = pushCheckWorld("declined-push");
    const session = { isHost: false, localSeat: { seatId: "seat-player", role: "player", displayName: "玩家" }, submitConfirmed: vi.fn(), isAuthenticated: true } as unknown as RoomSessionV2;

    render(<CheckNegotiationV2 world={world} session={session} />);

    expect(screen.getByLabelText("强推的新做法")).toBeTruthy();
    expect(screen.getByRole("button", { name: "换一种做法申请强推" })).toBeTruthy();
  });

  it("requires KP to state the severe failure consequence before authorizing a pushed check", async () => {
    const world = pushCheckWorld("pending-push");
    const submitConfirmed = vi.fn().mockResolvedValue("push-authorized");
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<CheckNegotiationV2 world={world} session={session} />);

    expect(screen.getByLabelText("强推申请：林默")).toBeTruthy();
    const allowPush = screen.getByRole("button", { name: "允许强推（普通）" });
    expect(allowPush.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("强推失败代价：林默"), { target: { value: "撬棍会折断，巨响惊醒地下沉睡的东西。" } });
    expect(allowPush.hasAttribute("disabled")).toBe(false);
    fireEvent.click(allowPush);

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledWith({
      type: "check.authorized",
      audience: { kind: "room" },
      payload: {
        requestId: "check-push",
        skillName: "侦查",
        target: 60,
        requiredDifficulty: "regular",
        bonusDice: 0,
        penaltyDice: 0,
        note: "KP 已说明强推再次失败的代价。",
        failureConsequence: "撬棍会折断，巨响惊醒地下沉睡的东西。",
      },
    }));
  });

  it("shows the authorized failure consequence before the player can accept and roll the push", async () => {
    const world = pushCheckWorld("authorized-push");
    const rollDice = vi.fn().mockResolvedValue("push-roll");
    const session = { isHost: false, localSeat: { seatId: "seat-player", role: "player", displayName: "玩家" }, rollDice, submitConfirmed: vi.fn(), isAuthenticated: true } as unknown as RoomSessionV2;

    render(<CheckNegotiationV2 world={world} session={session} />);

    const decision = screen.getByLabelText("决定是否进行强推");
    expect(decision.textContent).toContain("撬棍会折断，巨响惊醒地下沉睡的东西");
    expect(screen.queryByRole("button", { name: "掷骰：侦查（60）" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "接受代价并强推" }));

    await waitFor(() => expect(rollDice).toHaveBeenCalledWith({
      expression: "1d100",
      reason: "强推 侦查：拆下铰链销，从门背面拨锁",
      bonusDice: 0,
      penaltyDice: 0,
      target: 60,
      requiredDifficulty: "regular",
      checkRequestId: "check-push",
    }));
  });

  it("lets the player decline an authorized push after reading the consequence", async () => {
    const world = pushCheckWorld("authorized-push");
    const submitConfirmed = vi.fn().mockResolvedValue("push-declined");
    const session = { isHost: false, localSeat: { seatId: "seat-player", role: "player", displayName: "玩家" }, rollDice: vi.fn(), submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<CheckNegotiationV2 world={world} session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "不强推" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledWith({
      type: "check.closed",
      audience: { kind: "room" },
      payload: {
        requestId: "check-push",
        outcome: "cancelled",
        note: "调查员知晓再次失败的代价后，决定不进行强推。",
      },
    }));
  });

  it("does not leave a closed authorized push in the player's ready actions", () => {
    const world = pushCheckWorld("authorized-push-closed");
    const session = { isHost: false, localSeat: { seatId: "seat-player", role: "player", displayName: "玩家" }, rollDice: vi.fn(), submitConfirmed: vi.fn(), isAuthenticated: true } as unknown as RoomSessionV2;

    render(<CheckNegotiationV2 world={world} session={session} />);

    expect(screen.queryByLabelText("决定是否进行强推")).toBeNull();
    expect(screen.queryByRole("button", { name: "接受代价并强推" })).toBeNull();
    expect(screen.queryByLabelText("强推的新做法")).toBeNull();
  });

  it("records a non-exclusive personal focus marker for a shared clue", async () => {
    const world = createRoomWorldStateV2("room-clue");
    const character = investigator();
    const clue = clueArtifact();
    (world.latestCharacters as Map<string, Coc7Character>).set(character.id, character);
    (world.artifacts as Map<string, RoomArtifactV2>).set(clue.artifactId, clue);
    const submitConfirmed = vi.fn().mockResolvedValue("claim-command");
    const session = { isHost: false, localSeat: { seatId: "seat-player", role: "player", displayName: "玩家" }, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<PublicClueBoardV2 world={world} session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "加入我的线索栏" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledWith({
      type: "clue.claimed",
      audience: { kind: "room" },
      payload: { artifactId: clue.artifactId, characterId: character.id, characterName: character.name },
    }));
    expect(screen.getByText("倒放的曲序")).toBeTruthy();
  });

  it("removes the selected investigator's own focus marker without editing the shared clue", async () => {
    const world = createRoomWorldStateV2("room-unclaim-clue");
    const character = investigator();
    const clue = clueArtifact();
    (world.latestCharacters as Map<string, Coc7Character>).set(character.id, character);
    (world.artifacts as Map<string, RoomArtifactV2>).set(clue.artifactId, clue);
    (world.clueClaims as Map<string, never[]>).set(clue.artifactId, [{
      artifactId: clue.artifactId,
      characterId: character.id,
      characterName: character.name,
      seatId: "seat-player",
      displayName: "玩家",
      claimedAt: "2026-08-29T00:00:00.000Z",
    } as never]);
    const submitConfirmed = vi.fn().mockResolvedValue("unclaim-command");
    const session = { isHost: false, localSeat: { seatId: "seat-player", role: "player", displayName: "玩家" }, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<PublicClueBoardV2 world={world} session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "我的重点" }));
    fireEvent.click(screen.getByRole("button", { name: "移出我的重点" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledWith({
      type: "clue.unclaimed",
      audience: { kind: "room" },
      payload: { artifactId: clue.artifactId, characterId: character.id, characterName: character.name },
    }));
    expect(screen.getByText("倒放的曲序")).toBeTruthy();
  });

  it("renders an attachment-only public clue as a usable image", async () => {
    const world = createRoomWorldStateV2("room-image-only-clue");
    const image: AssetDescriptorV1 = {
      schemaVersion: 1,
      assetId: `sha256:${"c".repeat(64)}`,
      mediaType: "image/webp",
      byteLength: 4_096,
      width: 1200,
      height: 800,
    };
    const clue: RoomArtifactV2 = {
      ...clueArtifact(),
      artifactId: "clue-photograph",
      title: "码头旧照片",
      body: "",
      attachments: [image],
    };
    (world.artifacts as Map<string, RoomArtifactV2>).set(clue.artifactId, clue);
    const resolveAsset = vi.fn().mockResolvedValue("blob:projected-clue-image");

    render(<PublicClueBoardV2 world={world} readOnly resolveAsset={resolveAsset} />);

    const preview = await screen.findByRole("img", { name: "码头旧照片，图片附件 1" });
    expect(preview.getAttribute("src")).toBe("blob:projected-clue-image");
    expect(screen.getByRole("link", { name: "下载图片" }).getAttribute("download")).toBe("码头旧照片-1.webp");
    expect(resolveAsset).toHaveBeenCalledOnce();
    expect(resolveAsset).toHaveBeenCalledWith(image);
  });

  it("keeps the shared case file readable and explains personal focus when no character is present", () => {
    const world = createRoomWorldStateV2("room-clue-without-character");
    const clue = clueArtifact();
    (world.artifacts as Map<string, RoomArtifactV2>).set(clue.artifactId, clue);
    const session = { isHost: false, localSeat: { seatId: "seat-player", role: "player", displayName: "玩家" }, submitConfirmed: vi.fn(), isAuthenticated: true } as unknown as RoomSessionV2;

    render(<PublicClueBoardV2 world={world} session={session} />);

    expect(screen.getByRole("button", { name: "全部线索" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("倒放的曲序")).toBeTruthy();
    expect(screen.getByText(/你仍然可以阅读共同案卷/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "我的重点" }));
    expect(screen.getByText("还不能整理我的重点。")).toBeTruthy();
    expect(screen.getByText(/先在“我的调查员”中保存角色并带入房间/)).toBeTruthy();
    expect(screen.queryByText("倒放的曲序")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看全部线索" }));
    expect(screen.getByText("倒放的曲序")).toBeTruthy();
  });

  it("switches personal focus with the selected locally owned investigator", () => {
    const world = createRoomWorldStateV2("room-multiple-character-clues");
    const firstCharacter = investigator();
    const secondCharacter: Coc7Character = { ...investigator(), id: "character-professor", name: "许文彬", occupation: "大学教授" };
    const firstClue = clueArtifact();
    const secondClue: RoomArtifactV2 = { ...clueArtifact(), artifactId: "clue-burned-letter", title: "烧焦的信纸", body: "信纸边缘残留着蓝色蜡痕。" };
    (world.latestCharacters as Map<string, Coc7Character>).set(firstCharacter.id, firstCharacter);
    (world.latestCharacters as Map<string, Coc7Character>).set(secondCharacter.id, secondCharacter);
    (world.artifacts as Map<string, RoomArtifactV2>).set(firstClue.artifactId, firstClue);
    (world.artifacts as Map<string, RoomArtifactV2>).set(secondClue.artifactId, secondClue);
    (world.clueClaims as Map<string, never[]>).set(firstClue.artifactId, [{
      artifactId: firstClue.artifactId,
      characterId: firstCharacter.id,
      characterName: firstCharacter.name,
      seatId: "seat-player",
      displayName: "玩家",
      claimedAt: "2026-08-29T00:00:00.000Z",
    } as never]);
    (world.clueClaims as Map<string, never[]>).set(secondClue.artifactId, [{
      artifactId: secondClue.artifactId,
      characterId: secondCharacter.id,
      characterName: secondCharacter.name,
      seatId: "seat-player",
      displayName: "玩家",
      claimedAt: "2026-08-29T00:00:01.000Z",
    } as never]);
    const session = { isHost: false, localSeat: { seatId: "seat-player", role: "player", displayName: "玩家" }, submitConfirmed: vi.fn(), isAuthenticated: true } as unknown as RoomSessionV2;

    render(<PublicClueBoardV2 world={world} session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "我的重点" }));

    expect(screen.getByText("倒放的曲序")).toBeTruthy();
    expect(screen.queryByText("烧焦的信纸")).toBeNull();

    fireEvent.change(screen.getByLabelText("整理哪位调查员的线索栏"), { target: { value: secondCharacter.id } });
    expect(screen.queryByText("倒放的曲序")).toBeNull();
    expect(screen.getByText("烧焦的信纸")).toBeTruthy();
  });

  it("puts only a narrow scene reference on the drag clipboard", () => {
    const world = createRoomWorldStateV2("room-module-drag");
    const board = mapBoard();
    const modulePackage = moduleFixture();
    const setData = vi.fn();
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, world, submitConfirmed: vi.fn(), isAuthenticated: true } as unknown as RoomSessionV2;

    render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} board={board} session={session} />);
    fireEvent.dragStart(screen.getByRole("button", { name: "模组场景：后台唱片室" }), {
      dataTransfer: { setData, effectAllowed: "none" },
    });

    expect(setData).toHaveBeenCalledWith(BOARD_EXTERNAL_DROP_MIME, JSON.stringify({
      kind: "module-scene",
      moduleId: modulePackage.moduleId,
      revision: modulePackage.revision,
      sceneId: "scene-source",
    }));
    const serialized = setData.mock.calls[0]?.[1] as string;
    expect(serialized).not.toContain("KP 秘密");
    expect(serialized).not.toContain("keeperNotes");
  });

  it("keeps a scene marker within a secret board audience", async () => {
    const world = createRoomWorldStateV2("room-secret-scene");
    const board = { ...mapBoard(), audience: { kind: "host" as const } };
    (world.boards as Map<string, BoardV1>).set(board.boardId, board);
    const submitConfirmed = vi.fn().mockResolvedValue("confirmed");
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, world, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<KeeperModuleWorkbenchV2 modulePackage={moduleFixture()} world={world} board={board} session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "放到当前地图中央" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledTimes(2));
    const serialized = JSON.stringify(submitConfirmed.mock.calls);
    expect(submitConfirmed.mock.calls[0]?.[0]).toMatchObject({
      type: "entity.upserted",
      audience: { kind: "host" },
      payload: { entity: { audience: { kind: "host" }, description: "" } },
    });
    expect(submitConfirmed.mock.calls[1]?.[0]).toMatchObject({
      type: "board.item.upserted",
      audience: { kind: "host" },
      payload: { item: { audience: { kind: "host" } } },
    });
    expect(serialized).not.toContain("KP 秘密");
    expect(serialized).not.toContain("keeperNotes");
  });

  it("aligns the keeper guide step with the selected scene and walks the trail", () => {
    const base = twoSceneModuleFixture();
    const modulePackage: ModulePackageV1 = {
      ...base,
      keeperGuide: {
        schemaVersion: 1,
        truth: "剧院的曲目是召唤仪式。",
        hook: "从后台唱片室开场。",
        clueTrail: [
          {
            sceneId: "scene-source",
            title: "唱片室的异样",
            goal: "让玩家拿到倒放曲序",
            leadIn: "委托直接引到这里。",
            keyClues: [{ clueId: "clue-source", summary: "曲目从终幕向序曲倒放", pointsTo: "地下档案室" }],
            ifStuck: "让演员失手掉落节目单。",
          },
          {
            sceneId: "scene-archive",
            title: "档案室的暗门",
            goal: "发现暗门",
            leadIn: "顺着曲序找到档案室。",
            keyClues: [],
            ifStuck: "",
          },
        ],
        timeline: [],
        endings: [{ title: "落幕", condition: "", outcome: "" }],
        pacing: "",
      },
    };
    const world = createRoomWorldStateV2("room-guide-strip");
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, world, submitConfirmed: vi.fn(), isAuthenticated: true } as unknown as RoomSessionV2;

    render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} session={session} />);

    // The first scene is selected by default; its guide step shows the goal,
    // an unpublished key clue, and the backup path.
    expect(screen.getByText(/运行指引 · 第 1\/2 步：唱片室的异样/)).toBeTruthy();
    expect(screen.getByText(/这一步要达成：/)).toBeTruthy();
    expect(screen.getByText("○ 待公开")).toBeTruthy();
    expect(screen.getByText(/卡关补救：/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "准备下一场：地下档案室" }));
    expect(screen.getByText(/运行指引 · 第 2\/2 步：档案室的暗门/)).toBeTruthy();
    expect(screen.getByText(/已是线索链最后一步 · 可选结局：落幕/)).toBeTruthy();
  });

  it("requires KP to write the player-facing opening before presenting a scene", () => {
    const world = createRoomWorldStateV2("room-scene-opening-required");
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, world, submitConfirmed: vi.fn(), isAuthenticated: true } as unknown as RoomSessionV2;

    render(<KeeperModuleWorkbenchV2 modulePackage={moduleFixture()} world={world} session={session} />);

    expect(screen.getByRole("button", { name: "向所有人呈现这个场景" }).hasAttribute("disabled")).toBe(true);
    expect((screen.getByLabelText("玩家可见的开场描述") as HTMLTextAreaElement).value).toBe("");
  });

  it("restores the director workbench to the room's active module scene", () => {
    const world = createRoomWorldStateV2("room-restored-active-scene");
    const modulePackage = twoSceneModuleFixture();
    const activeScene = {
      ...entity("scene-archive-room", "scene", "地下档案室", {
        sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "scene", id: "scene-archive" },
      }),
      description: "铁架之间积着厚厚的灰尘。",
    };
    (world.entities as Map<string, RoomEntityV2>).set(activeScene.entityId, activeScene);
    (world as { activeSceneEntityId?: string }).activeSceneEntityId = activeScene.entityId;
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, world, submitConfirmed: vi.fn(), isAuthenticated: true } as unknown as RoomSessionV2;

    render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} session={session} />);

    expect(screen.getByRole("button", { name: "模组场景：地下档案室" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "模组场景：地下档案室" }).textContent).toContain("当前情境");
    expect(screen.getByRole("button", { name: "模组场景：后台唱片室" }).getAttribute("aria-pressed")).toBe("false");
    expect((screen.getByLabelText("玩家可见的开场描述") as HTMLTextAreaElement).value).toBe("铁架之间积着厚厚的灰尘。");
    expect(screen.getByRole("button", { name: "已呈现，修改后可更新" }).hasAttribute("disabled")).toBe(true);
  });

  it("never renders the complete KP module package for a player caller", () => {
    const world = createRoomWorldStateV2("room-player-must-not-see-module");
    const session = { isHost: false, localSeat: { seatId: "seat-player", role: "player", displayName: "玩家" }, world, submitConfirmed: vi.fn(), isAuthenticated: true } as unknown as RoomSessionV2;

    render(<KeeperModuleWorkbenchV2 modulePackage={moduleFixture()} world={world} session={session} />);

    expect(screen.queryByLabelText("推进当前场景")).toBeNull();
    expect(screen.queryByText("KP 知道门锁已被调包")).toBeNull();
    expect(screen.queryByText("KP 秘密动机")).toBeNull();
  });

  it("keeps the facts KP needs beside the exact public text and check consequences", async () => {
    const world = createRoomWorldStateV2("room-keeper-quick-reference");
    const base = moduleFixture();
    const modulePackage: ModulePackageV1 = {
      ...base,
      scenes: [{ ...base.scenes[0]!, suggestedCheckIds: ["check-listen"] }],
      suggestedChecks: [{
        id: "check-listen",
        skill: "聆听",
        difficulty: "hard",
        purpose: "从雨声里分辨唱针跳针的规律。",
        onSuccess: "听出每隔七拍会倒放一句人声。",
        onFailure: "误把脚步声当成唱片声，让躲藏的人先发现调查员。",
        sourceRefs: [],
      }],
    };
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, world, submitConfirmed: vi.fn(), isAuthenticated: true } as unknown as RoomSessionV2;

    render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} session={session} />);

    expect(screen.getByLabelText("仅 KP 参考：剧院后门").textContent).toContain("KP 知道门锁已被调包");
    expect((screen.getByLabelText("玩家可见介绍：剧院后门") as HTMLTextAreaElement).value).toBe("");
    const reference = screen.getByLabelText("本幕登场参考：剧院后门");
    fireEvent.click(within(reference).getByText("查看以前的介绍（未按本幕核对）"));
    await waitFor(() => expect((within(reference).getByRole("button", { name: "复制旧介绍后修改" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(reference).getByRole("button", { name: "复制旧介绍后修改" }));
    expect(screen.getByLabelText("公开预览：剧院后门").textContent).toContain("锈蚀的铁门上挂着一道崭新的锁");
    expect(screen.getByLabelText("仅 KP 参考：沉默的演员").textContent).toContain("动机：KP 秘密动机");
    expect(screen.getByLabelText("仅 KP 参考：核心 · 倒放的曲序").textContent).toContain("KP 才能知道的线索含义");
    const checkReference = screen.getByLabelText("检定参考：聆听");
    expect(checkReference.textContent).toContain("成功：听出每隔七拍会倒放一句人声");
    expect(checkReference.textContent).toContain("失败：误把脚步声当成唱片声");
  });

  it("marks information already visible to players instead of inviting KP to publish it twice", () => {
    const world = createRoomWorldStateV2("room-publication-memory");
    const modulePackage = moduleFixture();
    const presentedScene = {
      ...entity("scene-presented", "scene", "后台唱片室", {
        sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "scene", id: "scene-source" },
      }),
      description: "门后传来唱针摩擦声。",
    };
    const roomLocation = {
      ...entity("location-presented", "location", "剧院后门", {
        sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "location", id: "location-source" },
        presentedInSceneEntityIds: [presentedScene.entityId],
      }),
      description: "锈蚀的铁门上挂着一道崭新的锁。",
    };
    const roomNpc = {
      ...entity("npc-presented", "npc", "沉默的演员", {
        sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "npc", id: "npc-source" },
        presentedInSceneEntityIds: [presentedScene.entityId],
      }),
      description: "一个浑身湿透、神情紧张的年轻演员。",
    };
    const publishedClue: RoomArtifactV2 = {
      ...clueArtifact(),
      extensions: { sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "clue", id: "clue-source" } },
    };
    (world.entities as Map<string, RoomEntityV2>).set(presentedScene.entityId, presentedScene);
    (world.entities as Map<string, RoomEntityV2>).set(roomLocation.entityId, roomLocation);
    (world.entities as Map<string, RoomEntityV2>).set(roomNpc.entityId, roomNpc);
    (world.artifacts as Map<string, RoomArtifactV2>).set(publishedClue.artifactId, publishedClue);
    (world as { activeSceneEntityId?: string }).activeSceneEntityId = presentedScene.entityId;
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, world, submitConfirmed: vi.fn(), isAuthenticated: true } as unknown as RoomSessionV2;

    render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} session={session} />);

    const presentedButtons = screen.getAllByRole("button", { name: "已在当前情境公开" });
    expect(presentedButtons).toHaveLength(2);
    expect(presentedButtons.every((button) => button.hasAttribute("disabled"))).toBe(true);
    expect(screen.getAllByText("玩家已看见")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "已在调查案卷" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("已进入共同案卷")).toBeTruthy();
  });

  it("restores an archived module clue to the shared case file without creating a duplicate", async () => {
    const world = createRoomWorldStateV2("room-restore-module-clue");
    const modulePackage = moduleFixture();
    const activeScene = entity("scene-active-for-clue-restore", "scene", "后台唱片室", {
      sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "scene", id: "scene-source" },
    });
    const archivedClue: RoomArtifactV2 = {
      ...clueArtifact(),
      revision: 4,
      archived: true,
      extensions: {
        sourceRef: {
          moduleId: modulePackage.moduleId,
          revision: modulePackage.revision,
          kind: "clue",
          id: "clue-source",
        },
      },
    };
    (world.entities as Map<string, RoomEntityV2>).set(activeScene.entityId, activeScene);
    (world.artifacts as Map<string, RoomArtifactV2>).set(archivedClue.artifactId, archivedClue);
    (world as { activeSceneEntityId?: string }).activeSceneEntityId = activeScene.entityId;
    const submitConfirmed = vi.fn().mockResolvedValue("restored");
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, world, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} session={session} />);

    expect(screen.getByText("已收起")).toBeTruthy();
    const restoreButton = screen.getByRole("button", { name: "重新放回调查案卷" });
    expect(restoreButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(restoreButton);

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledTimes(1));
    expect(submitConfirmed).toHaveBeenCalledWith({
      type: "artifact.upserted",
      audience: { kind: "room" },
      payload: {
        artifact: {
          ...archivedClue,
          revision: 5,
          archived: false,
        },
      },
    });
  });

  it("turns a map entry into one explicit KP action without revealing the next scene", () => {
    const world = createRoomWorldStateV2("room-map-entry-prompt");
    const modulePackage = twoSceneModuleFixture();
    const currentScene = {
      ...entity("scene-record-room", "scene", "后台唱片室", {
        sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "scene", id: "scene-source" },
      }),
      description: "门后传来唱针摩擦声。",
    };
    const enteredScene = entity("scene-archive-zone", "scene", "地下档案室", {
      sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "scene", id: "scene-archive" },
    });
    const character = entity("entity-reporter", "character", "林默", {
      characterId: "character-reporter",
      ownerSeatId: "seat-player",
    });
    (world.entities as Map<string, RoomEntityV2>).set(currentScene.entityId, currentScene);
    (world.entities as Map<string, RoomEntityV2>).set(enteredScene.entityId, enteredScene);
    (world.entities as Map<string, RoomEntityV2>).set(character.entityId, character);
    (world as { activeSceneEntityId?: string }).activeSceneEntityId = currentScene.entityId;
    const board = mapBoard();
    board.items = [
      item("item-archive-zone", enteredScene.entityId, { x: 800, y: 450 }, { width: 420, height: 260 }, true),
      item("item-reporter", character.entityId, { x: 800, y: 450 }, { width: 130, height: 130 }, false),
    ];
    const submitConfirmed = vi.fn();
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, world, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} board={board} session={session} />);

    expect(screen.getByRole("status", { name: "调查员进入了另一个场景" }).textContent).toContain("林默进入了“地下档案室”");
    expect(screen.getByRole("button", { name: "模组场景：后台唱片室" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "查看并准备呈现：地下档案室" }));

    expect(screen.getByRole("button", { name: "模组场景：地下档案室" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("玩家可见的开场描述") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByRole("button", { name: "向所有人呈现这个场景" }).hasAttribute("disabled")).toBe(true);
    expect(submitConfirmed).not.toHaveBeenCalled();
  });

  it("shows every simultaneous scene entry instead of silently choosing the first one", () => {
    const world = createRoomWorldStateV2("room-multiple-map-entry-prompts");
    const baseModule = twoSceneModuleFixture();
    const modulePackage: ModulePackageV1 = {
      ...baseModule,
      scenes: [
        ...baseModule.scenes,
        {
          ...baseModule.scenes[1]!,
          id: "scene-projection",
          name: "废弃放映室",
          locationIds: [],
          npcIds: [],
          clueIds: [],
        },
      ],
    };
    const currentScene = entity("scene-current-multi", "scene", "后台唱片室", {
      sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "scene", id: "scene-source" },
    });
    const archiveScene = entity("scene-archive-multi", "scene", "地下档案室", {
      sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "scene", id: "scene-archive" },
    });
    const projectionScene = entity("scene-projection-multi", "scene", "废弃放映室", {
      sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "scene", id: "scene-projection" },
    });
    const reporter = entity("entity-reporter-multi", "character", "林默", { characterId: "character-reporter", ownerSeatId: "seat-player" });
    const doctor = entity("entity-doctor-multi", "character", "周医生", { characterId: "character-doctor", ownerSeatId: "seat-doctor" });
    for (const roomEntity of [currentScene, archiveScene, projectionScene, reporter, doctor]) {
      (world.entities as Map<string, RoomEntityV2>).set(roomEntity.entityId, roomEntity);
    }
    (world as { activeSceneEntityId?: string }).activeSceneEntityId = currentScene.entityId;
    const board = mapBoard();
    board.items = [
      item("item-archive-zone-multi", archiveScene.entityId, { x: 500, y: 350 }, { width: 360, height: 240 }, true),
      item("item-projection-zone-multi", projectionScene.entityId, { x: 1120, y: 600 }, { width: 360, height: 240 }, true),
      item("item-reporter-multi", reporter.entityId, { x: 500, y: 350 }, { width: 120, height: 120 }, false),
      item("item-doctor-multi", doctor.entityId, { x: 1120, y: 600 }, { width: 120, height: 120 }, false),
    ];
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, world, submitConfirmed: vi.fn(), isAuthenticated: true } as unknown as RoomSessionV2;

    render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} board={board} session={session} />);

    const prompt = screen.getByRole("status", { name: "调查员进入了另一个场景" });
    expect(prompt.textContent).toContain("林默进入了“地下档案室”");
    expect(prompt.textContent).toContain("周医生进入了“废弃放映室”");
    expect(within(prompt).getByRole("button", { name: "查看并准备呈现：地下档案室" })).toBeTruthy();
    fireEvent.click(within(prompt).getByRole("button", { name: "查看并准备呈现：废弃放映室" }));
    expect(screen.getByRole("button", { name: "模组场景：废弃放映室" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps related locations and NPCs locked while KP previews a non-current scene", async () => {
    const world = createRoomWorldStateV2("room-preview-non-current-scene");
    const modulePackage = twoSceneModuleFixture();
    const currentScene = {
      ...entity("scene-record-room", "scene", "后台唱片室", {
        sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "scene", id: "scene-source" },
      }),
      description: "门后传来唱针摩擦声。",
    };
    const previewedScene = {
      ...entity("scene-archive-room", "scene", "地下档案室", {
        sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "scene", id: "scene-archive" },
      }),
      description: "铁架之间积着厚厚的灰尘。",
    };
    (world.entities as Map<string, RoomEntityV2>).set(currentScene.entityId, currentScene);
    (world.entities as Map<string, RoomEntityV2>).set(previewedScene.entityId, previewedScene);
    (world as { activeSceneEntityId?: string }).activeSceneEntityId = currentScene.entityId;
    const submitConfirmed = vi.fn().mockResolvedValue("confirmed");
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, world, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "模组场景：地下档案室" }));

    await waitFor(() => expect((screen.getByLabelText("玩家可见的开场描述") as HTMLTextAreaElement).value).toBe("铁架之间积着厚厚的灰尘。"));
    const guardedActions = screen.getAllByRole("button", { name: "先切换到此场景" });
    expect(guardedActions).toHaveLength(2);
    expect(guardedActions.every((button) => button.hasAttribute("disabled"))).toBe(true);
    expect(screen.getByRole("button", { name: "向所有人呈现这个场景" }).hasAttribute("disabled")).toBe(false);
    expect(submitConfirmed).not.toHaveBeenCalled();
  });

  it("blocks a related clue until the selected module scene becomes the active published scene", async () => {
    const world = createRoomWorldStateV2("room-preview-non-current-scene-clue");
    const modulePackage = floatingClueModuleFixture();
    const currentScene = entity("scene-current-for-clue-guard", "scene", "后台唱片室", {
      sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "scene", id: "scene-source" },
    });
    const previewedScene = {
      ...entity("scene-preview-for-clue-guard", "scene", "地下档案室", {
        sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "scene", id: "scene-archive" },
      }),
      description: "铁架之间积着厚厚的灰尘。",
    };
    (world.entities as Map<string, RoomEntityV2>).set(currentScene.entityId, currentScene);
    (world.entities as Map<string, RoomEntityV2>).set(previewedScene.entityId, previewedScene);
    (world as { activeSceneEntityId?: string }).activeSceneEntityId = currentScene.entityId;
    const submitConfirmed = vi.fn().mockResolvedValue("confirmed");
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, world, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "模组场景：地下档案室" }));

    await waitFor(() => expect((screen.getByLabelText("玩家可见的开场描述") as HTMLTextAreaElement).value).toBe("铁架之间积着厚厚的灰尘。"));
    const clueRow = screen.getByLabelText("模组线索：失踪者登记簿");
    const guardedButton = within(clueRow).getByRole("button", { name: "先切换到此场景" });
    expect(guardedButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(guardedButton);
    expect(submitConfirmed).not.toHaveBeenCalled();
  });

  it("presents only KP's explicit public opening and focuses it without requiring a board", async () => {
    const world = createRoomWorldStateV2("room-scene-opening");
    const submitConfirmed = vi.fn().mockResolvedValue("confirmed");
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, world, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;
    const publicOpening = "雨水敲打剧院后门，门缝里传来断续的唱针摩擦声。";

    render(<KeeperModuleWorkbenchV2 modulePackage={moduleFixture()} world={world} session={session} />);
    await waitFor(() => expect(screen.getByLabelText("玩家可见的开场描述").hasAttribute("disabled")).toBe(false));
    fireEvent.change(screen.getByLabelText("玩家可见的开场描述"), { target: { value: publicOpening } });
    fireEvent.click(screen.getByRole("button", { name: "向所有人呈现这个场景" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledTimes(2));
    const publishedEntity = submitConfirmed.mock.calls[0]?.[0];
    expect(publishedEntity).toMatchObject({
      type: "entity.upserted",
      audience: { kind: "room" },
      payload: { entity: { kind: "scene", name: "后台唱片室", description: publicOpening, audience: { kind: "room" } } },
    });
    expect(submitConfirmed.mock.calls[1]?.[0]).toMatchObject({
      type: "scene.focused",
      audience: { kind: "room" },
      payload: { sceneEntityId: publishedEntity.payload.entity.entityId },
    });
    const serialized = JSON.stringify(submitConfirmed.mock.calls);
    expect(serialized).not.toContain("KP 秘密");
    expect(serialized).not.toContain("keeperNotes");
    expect(serialized).not.toContain("KP 才能知道的线索含义");
  });

  it("publishes only a clue's player-facing reveal text", async () => {
    const world = createRoomWorldStateV2("room-public-clue");
    const modulePackage = moduleFixture();
    const activeScene = entity("scene-active-for-public-clue", "scene", "后台唱片室", {
      sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "scene", id: "scene-source" },
    });
    (world.entities as Map<string, RoomEntityV2>).set(activeScene.entityId, activeScene);
    (world as { activeSceneEntityId?: string }).activeSceneEntityId = activeScene.entityId;
    const submitConfirmed = vi.fn().mockResolvedValue("confirmed");
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, world, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} session={session} />);
    const publishButton = screen.getByRole("button", { name: "公开到调查案卷" });
    expect(publishButton.parentElement?.textContent).toContain("尚未公开");
    fireEvent.click(publishButton);

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledTimes(1));
    expect(submitConfirmed.mock.calls[0]?.[0]).toMatchObject({
      type: "artifact.upserted",
      audience: { kind: "room" },
      payload: { artifact: { description: "", body: "曲目必须从终幕向序曲倒放。" } },
    });
    expect(JSON.stringify(submitConfirmed.mock.calls)).not.toContain("KP 才能知道的线索含义");
  });

  it("uses the adopted disclosure's conditions in both publication paths and flags later manual edits", async () => {
    const world = createRoomWorldStateV2("room-discovery-variants");
    const modulePackage = moduleFixture();
    const clue = modulePackage.clues[0]!;
    const note = { title: "发现条件", text: "仅供 KP 核对", kind: "advice" as const, sources: [] };
    const gated = { clueId: clue.id, text: "检定后才知道的食物产地。", when: { ...note, title: "辨认食物", text: "注意到食物并通过知识检定后透露。" } };
    const free = { clueId: clue.id, text: "侍女告诉你她来自长野。", when: { ...note, title: "直接询问", text: "询问侍女即可，无需检定。" } };
    modulePackage.keeperGuide = { schemaVersion: 1, truth: "", hook: "", clueTrail: [], timeline: [], endings: [], pacing: "", preparation: {
      truth: note, hook: note, essentials: [note], playerBriefing: note, cast: [], scenes: [], timeline: [], endings: [], publicClues: [gated, free],
    } };
    clue.revealText = free.text;
    const active = entity("scene-discovery-variants", "scene", "后台唱片室", { sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "scene", id: "scene-source" } });
    (world.entities as Map<string, RoomEntityV2>).set(active.entityId, active);
    (world as { activeSceneEntityId?: string }).activeSceneEntityId = active.entityId;
    const submitConfirmed = vi.fn().mockResolvedValue("confirmed");
    const session = { isHost: true, world, localSeat: { seatId: "seat-host", role: "host" }, submitConfirmed } as unknown as RoomSessionV2;
    const view = render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} session={session} />);
    const conditions = screen.getAllByLabelText(`发现条件：${clue.name}`);
    expect(conditions).toHaveLength(2);
    for (const element of conditions) {
      expect(element.textContent).toContain(free.when.text);
      expect(element.textContent).not.toContain(gated.when.text);
    }
    fireEvent.click(screen.getByRole("button", { name: "公开到调查案卷" }));
    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledOnce());
    expect(submitConfirmed.mock.calls[0]![0].payload.artifact.body).toBe(free.text);
    expect(JSON.stringify(submitConfirmed.mock.calls)).not.toContain(free.when.text);
    expect(JSON.stringify(submitConfirmed.mock.calls)).not.toContain(gated.text);

    const edited = { ...modulePackage, clues: [{ ...clue, revealText: "KP 手工合并的公开正文。" }, ...modulePackage.clues.slice(1)] };
    view.rerender(<KeeperModuleWorkbenchV2 modulePackage={edited} world={world} session={session} />);
    for (const element of screen.getAllByLabelText(`发现条件：${clue.name}`)) {
      expect(element.textContent).toContain("当前公开正文与草稿不同");
      expect(element.textContent).toContain(gated.when.text);
      expect(element.textContent).toContain(free.when.text);
      expect(element.textContent).toContain(gated.text);
      expect(element.textContent).toContain(free.text);
    }
  });

  it("returns current-scene matches beside the search box and preserves their publication guard", () => {
    const world = createRoomWorldStateV2("room-current-clue-search");
    const modulePackage = floatingClueModuleFixture();
    const submitConfirmed = vi.fn();
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host" }, world, submitConfirmed } as unknown as RoomSessionV2;
    render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} session={session} />);
    fireEvent.change(screen.getByLabelText("搜索全部模组线索"), { target: { value: "倒放" } });
    const results = screen.getByLabelText("模组线索搜索结果");
    expect(within(results).getByText("核心 · 倒放的曲序")).toBeTruthy();
    expect(within(results).queryByText("跨场景")).toBeNull();
    expect(within(results).getByRole("button", { name: "先呈现这个场景" }).hasAttribute("disabled")).toBe(true);
    expect(submitConfirmed).not.toHaveBeenCalled();
    expect(screen.getByLabelText("模组线索速查").compareDocumentPosition(screen.getByLabelText("向玩家呈现场景")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("marks a clue from another scene and requires explicit confirmation before publishing it", async () => {
    const world = createRoomWorldStateV2("room-floating-clue");
    const modulePackage = floatingClueModuleFixture();
    const submitConfirmed = vi.fn().mockResolvedValue("confirmed");
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, world, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} session={session} />);

    expect(screen.getByRole("button", { name: "模组场景：后台唱片室" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByLabelText("搜索全部模组线索"), { target: { value: "十七年前" } });
    const results = screen.getByLabelText("模组线索搜索结果");
    expect(within(results).getByText("失踪者登记簿")).toBeTruthy();
    expect(within(results).queryByText("核心 · 倒放的曲序")).toBeNull();
    expect(within(results).getByText("跨场景")).toBeTruthy();
    fireEvent.click(within(results).getByRole("button", { name: "跨场景发布…" }));

    expect(submitConfirmed).not.toHaveBeenCalled();
    const confirmation = within(results).getByRole("alert", { name: "跨场景发布确认：失踪者登记簿" });
    expect(confirmation.textContent).toContain("地下档案室");
    expect(confirmation.textContent).toContain("后台唱片室");
    fireEvent.click(within(confirmation).getByRole("button", { name: "确认跨场景公开" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledTimes(1));
    expect(submitConfirmed.mock.calls[0]?.[0]).toMatchObject({
      type: "artifact.upserted",
      audience: { kind: "room" },
      payload: {
        artifact: {
          title: "失踪者登记簿",
          description: "",
          body: "登记簿显示十七年前有三人在同一个雨夜失踪。",
        },
      },
    });
    const serialized = JSON.stringify(submitConfirmed.mock.calls);
    expect(serialized).not.toContain("KP 知道失踪者其实使用了假名");
    expect(serialized).not.toContain("scene-archive");
  });

  it("keeps published cross-scene clues visible as status instead of offering a duplicate", () => {
    const world = createRoomWorldStateV2("room-floating-clue-published");
    const modulePackage = floatingClueModuleFixture();
    const publishedClue: RoomArtifactV2 = {
      ...clueArtifact(),
      artifactId: "artifact-register",
      title: "失踪者登记簿",
      body: "登记簿显示十七年前有三人在同一个雨夜失踪。",
      extensions: { sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "clue", id: "clue-register" } },
    };
    (world.artifacts as Map<string, RoomArtifactV2>).set(publishedClue.artifactId, publishedClue);
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, world, submitConfirmed: vi.fn(), isAuthenticated: true } as unknown as RoomSessionV2;

    render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} session={session} />);
    fireEvent.change(screen.getByLabelText("搜索全部模组线索"), { target: { value: "登记簿" } });

    const results = screen.getByLabelText("模组线索搜索结果");
    expect(within(results).getByText("已进入共同案卷")).toBeTruthy();
    expect(within(results).getByRole("button", { name: "已在调查案卷" }).hasAttribute("disabled")).toBe(true);
  });

  it("can publish from the shared clue catalog even when the module has no scene", async () => {
    const world = createRoomWorldStateV2("room-clue-without-scene");
    const base = floatingClueModuleFixture();
    const modulePackage: ModulePackageV1 = { ...base, scenes: [], clues: [base.clues[1]!] };
    const submitConfirmed = vi.fn().mockResolvedValue("confirmed");
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, world, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} session={session} />);

    expect(screen.getByText("全部模组线索")).toBeTruthy();
    expect(screen.queryByLabelText("向玩家呈现场景")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "公开到调查案卷" }));
    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledTimes(1));
    expect(submitConfirmed.mock.calls[0]?.[0]).toMatchObject({
      type: "artifact.upserted",
      payload: { artifact: { title: "失踪者登记簿", body: "登记簿显示十七年前有三人在同一个雨夜失踪。" } },
    });
  });

  it("explains an empty full-module clue search without hiding the current scene clues", () => {
    const world = createRoomWorldStateV2("room-floating-clue-empty-search");
    const modulePackage = floatingClueModuleFixture();
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, world, submitConfirmed: vi.fn(), isAuthenticated: true } as unknown as RoomSessionV2;

    render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} session={session} />);
    fireEvent.change(screen.getByLabelText("搜索全部模组线索"), { target: { value: "绝不存在的钟楼" } });

    expect(screen.getByRole("status").textContent).toContain("没有找到与“绝不存在的钟楼”相符的线索");
    expect(screen.getAllByText("核心 · 倒放的曲序")).toHaveLength(1);
    expect(within(screen.getByLabelText("模组线索搜索结果")).queryByRole("button")).toBeNull();
  });

  it("records a public NPC appearance against the presented scene without making it a child entity", async () => {
    const world = createRoomWorldStateV2("room-public-npc-appearance");
    const board = mapBoard();
    const presentedScene = { ...entity("scene-presented", "scene", "后台唱片室", { sourceRef: { moduleId: "module-terminal-opus", revision: 1, kind: "scene", id: "scene-source" } }), description: "门后传来唱针摩擦声。" };
    (world.entities as Map<string, RoomEntityV2>).set(presentedScene.entityId, presentedScene);
    (world.boards as Map<string, BoardV1>).set(board.boardId, board);
    (world as { activeSceneEntityId?: string }).activeSceneEntityId = presentedScene.entityId;
    const submitConfirmed = vi.fn().mockResolvedValue("confirmed");
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, world, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<KeeperModuleWorkbenchV2 modulePackage={moduleFixture()} world={world} board={board} session={session} />);
    await waitFor(() => expect((screen.getByLabelText("玩家可见介绍：沉默的演员") as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("玩家可见介绍：沉默的演员"), { target: { value: "一个浑身湿透、神情紧张的年轻演员。" } });
    fireEvent.click(screen.getByRole("button", { name: "让 NPC 在当前情境登场" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledOnce());
    expect(submitConfirmed.mock.calls[0]?.[0]).toMatchObject({
      type: "entity.upserted",
      payload: { entity: { kind: "npc", name: "沉默的演员", description: "一个浑身湿透、神情紧张的年轻演员。" } },
    });
    expect(submitConfirmed.mock.calls[0]?.[0]).toMatchObject({
      type: "entity.upserted",
      payload: { entity: { kind: "npc", data: { presentedInSceneEntityIds: [presentedScene.entityId] } } },
    });
    expect(submitConfirmed.mock.calls.some(([proposal]) => proposal.type === "board.item.upserted")).toBe(false);
    expect(JSON.stringify(submitConfirmed.mock.calls)).not.toContain("演员试图掩盖自己的身份");
  });

  it("places NPC representations only after publication and can create more than one visual token", async () => {
    const world = createRoomWorldStateV2("room-explicit-npc-representation");
    const modulePackage = moduleFixture();
    const board = mapBoard();
    const presentedScene = { ...entity("scene-presented-placement", "scene", "后台唱片室", { sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "scene", id: "scene-source" } }), description: "门后传来唱针摩擦声。" };
    const roomNpc = {
      ...entity("npc-presented-placement", "npc", "沉默的演员", {
        sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "npc", id: "npc-source" },
        presentedInSceneEntityIds: [presentedScene.entityId],
      }),
      description: "一个浑身湿透、神情紧张的年轻演员。",
    };
    const existingRepresentation = item("npc-token-existing", roomNpc.entityId, { x: 600, y: 420 }, { width: 120, height: 120 }, false);
    board.items = [existingRepresentation];
    for (const roomEntity of [presentedScene, roomNpc]) (world.entities as Map<string, RoomEntityV2>).set(roomEntity.entityId, roomEntity);
    (world.boards as Map<string, BoardV1>).set(board.boardId, board);
    (world as { activeSceneEntityId?: string }).activeSceneEntityId = presentedScene.entityId;
    const submitConfirmed = vi.fn().mockResolvedValue("confirmed");
    const session = { isHost: true, localSeat: { seatId: "seat-host", role: "host", displayName: "KP" }, world, submitConfirmed, isAuthenticated: true } as unknown as RoomSessionV2;

    render(<KeeperModuleWorkbenchV2 modulePackage={modulePackage} world={world} board={board} session={session} />);
    expect(screen.getByText("当前画面已有 1 个表现棋子")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "再放一个 NPC 棋子" }));

    await waitFor(() => expect(submitConfirmed).toHaveBeenCalledTimes(1));
    expect(submitConfirmed.mock.calls[0]?.[0]).toMatchObject({
      type: "board.item.upserted",
      payload: {
        boardId: board.boardId,
        item: { reference: { kind: "entity", entityId: roomNpc.entityId } },
      },
    });
    expect(submitConfirmed.mock.calls[0]?.[0].payload.item.itemId).not.toBe(existingRepresentation.itemId);
  });
});

function mapBoard(): BoardV1 {
  return { schemaVersion: 1, boardId: "board-map", revision: 1, kind: "map", name: "剧院地图", description: "", audience: { kind: "room" }, logicalSize: { width: 1_600, height: 900 }, archived: false, items: [], edges: [], extensions: {} };
}

function entity(entityId: string, kind: RoomEntityV2["kind"], name: string, data: Record<string, unknown>): RoomEntityV2 {
  return { schemaVersion: 2, entityId, revision: 1, kind, name, description: "", artifactIds: [], audience: { kind: "room" }, data, extensions: {} };
}

function item(itemId: string, entityId: string, position: { x: number; y: number }, size: { width: number; height: number }, locked: boolean) {
  return { schemaVersion: 1 as const, itemId, reference: { kind: "entity" as const, entityId }, label: itemId, position, size, rotationDegrees: 0, scale: 1, zIndex: 0, locked, audience: { kind: "room" as const }, extensions: {} };
}

function investigator(): Coc7Character {
  return {
    schemaVersion: 1, id: "character-reporter", ownerPeerId: "seat-player", name: "林默", playerName: "玩家", occupation: "调查记者", age: 29, residence: "东京", birthplace: "横滨",
    characteristics: { str: 45, con: 55, siz: 50, dex: 60, app: 55, int: 70, pow: 60, edu: 65, luck: 50 },
    derived: { hitPoints: 10, maxHitPoints: 10, magicPoints: 12, maxMagicPoints: 12, sanity: 60, maxSanity: 99, movementRate: 8, build: 0, damageBonus: "0" },
    skills: [{ id: "skill-spot", name: "侦查", baseValue: 25, value: 60, checked: false }], inventory: [],
    status: { temporaryInsanity: false, indefiniteInsanity: false, majorWound: false, dying: false, unconscious: false },
    background: { personalDescription: "", ideologyAndBeliefs: "", significantPeople: "", meaningfulLocations: "", treasuredPossessions: "", traits: "", injuriesAndScars: "", phobiasAndManias: "", arcaneTomesSpellsAndArtifacts: "", encountersWithStrangeEntities: "" }, notes: "", updatedAt: "2026-08-29T00:00:00.000Z", extensions: {},
  };
}

/** A regular (non-push) check the KP has authorized but nobody has rolled yet. */
function regularReadyCheckWorld(resolution?: { resolvedByEventId: string; resolvedSuccess: boolean }) {
  const world = createRoomWorldStateV2("room-regular-ready");
  const character = investigator();
  (world.latestCharacters as Map<string, Coc7Character>).set(character.id, character);
  (world.checkRequests as Map<string, never>).set("check-spot", {
    requestId: "check-spot",
    characterId: character.id,
    characterName: character.name,
    skillName: "侦查",
    proposedTarget: 60,
    reason: "检查唱片机夹层",
    goal: "确认唱片机是否被动过",
    approach: "检查唱片机夹层",
    requesterSeatId: "seat-player",
    requestedAt: "2026-08-29T00:00:00.000Z",
    audience: { kind: "room" },
  } as never);
  (world.checkAuthorizations as Map<string, never>).set("check-spot", {
    requestId: "check-spot",
    skillName: "侦查",
    target: 60,
    requiredDifficulty: "hard",
    bonusDice: 1,
    penaltyDice: 0,
    note: "小心：失败会惊动楼下的人。",
    requesterSeatId: "seat-player",
    authorizedAt: "2026-08-29T00:00:01.000Z",
    ...(resolution ?? {}),
  } as never);
  return world;
}

type PushCheckWorldMode =
  | "failed"
  | "successful"
  | "unfinished"
  | "pending-push"
  | "failed-push"
  | "declined-push"
  | "authorized-push"
  | "authorized-push-closed"
  | "closed-original";

function pushCheckWorld(mode: PushCheckWorldMode) {
  const world = createRoomWorldStateV2(`room-push-${mode}`);
  const character = investigator();
  (world.latestCharacters as Map<string, Coc7Character>).set(character.id, character);
  (world.checkRequests as Map<string, never>).set("check-original", {
    requestId: "check-original",
    characterId: character.id,
    characterName: character.name,
    skillName: "侦查",
    proposedTarget: 60,
    reason: "用撬棍直接撬开地下室门锁",
    goal: "打开地下室门",
    approach: "用撬棍直接撬开地下室门锁",
    suggestedSkillName: "侦查",
    requesterSeatId: "seat-player",
    requestedAt: "2026-08-29T00:00:00.000Z",
    audience: { kind: "room" },
  } as never);
  (world.checkAuthorizations as Map<string, never>).set("check-original", {
    requestId: "check-original",
    skillName: "侦查",
    target: 60,
    requiredDifficulty: "regular",
    bonusDice: 0,
    penaltyDice: 0,
    note: "门锁已经锈死。",
    requesterSeatId: "seat-player",
    authorizedAt: "2026-08-29T00:00:01.000Z",
    ...(mode === "unfinished" ? {} : {
      resolvedByEventId: "event-original-roll",
      resolvedSuccess: mode === "successful",
    }),
  } as never);

  if (mode !== "unfinished") {
    (world.checkOutcomes as Map<string, never>).set("check-original", {
      requestId: "check-original",
      text: mode === "successful"
        ? "锁芯松开，门已经可以推开。"
        : "锁芯纹丝不动，门后却传来一声短促的摩擦声。",
      describedBySeatId: "seat-host",
      describedAt: "2026-08-29T00:00:02.000Z",
      audience: { kind: "room" },
    } as never);
  }

  if (mode === "closed-original") {
    (world.checkClosures as Map<string, never>).set("check-original", {
      requestId: "check-original",
      outcome: "cancelled",
      note: "这项检定已经结束。",
      closedBySeatId: "seat-player",
      closedByRole: "player",
      closedAt: "2026-08-29T00:00:03.000Z",
    } as never);
  }

  if (["pending-push", "failed-push", "declined-push", "authorized-push", "authorized-push-closed"].includes(mode)) {
    (world.checkRequests as Map<string, never>).set("check-push", {
      requestId: "check-push",
      characterId: character.id,
      characterName: character.name,
      skillName: "侦查",
      proposedTarget: 60,
      reason: "拆下铰链销，从门背面拨锁",
      goal: "打开地下室门",
      approach: "拆下铰链销，从门背面拨锁",
      suggestedSkillName: "侦查",
      pushOfRequestId: "check-original",
      requesterSeatId: "seat-player",
      requestedAt: "2026-08-29T00:00:04.000Z",
      audience: { kind: "room" },
    } as never);
  }

  if (["failed-push", "authorized-push", "authorized-push-closed"].includes(mode)) {
    (world.checkAuthorizations as Map<string, never>).set("check-push", {
      requestId: "check-push",
      skillName: "侦查",
      target: 60,
      requiredDifficulty: "regular",
      bonusDice: 0,
      penaltyDice: 0,
      note: "铰链也已经锈死。",
      failureConsequence: "撬棍会折断，巨响惊醒地下沉睡的东西。",
      requesterSeatId: "seat-player",
      authorizedAt: "2026-08-29T00:00:05.000Z",
      ...(mode === "failed-push" ? {
        resolvedByEventId: "event-push-roll",
        resolvedSuccess: false,
      } : {}),
    } as never);
  }

  if (mode === "declined-push") {
    (world.checkClosures as Map<string, never>).set("check-push", {
      requestId: "check-push",
      outcome: "declined",
      note: "这个做法当前不可行，请换一种方式。",
      closedBySeatId: "seat-host",
      closedByRole: "host",
      closedAt: "2026-08-29T00:00:05.000Z",
    } as never);
  }

  if (mode === "authorized-push-closed") {
    (world.checkClosures as Map<string, never>).set("check-push", {
      requestId: "check-push",
      outcome: "cancelled",
      note: "调查员决定不承担这个后果。",
      closedBySeatId: "seat-player",
      closedByRole: "player",
      closedAt: "2026-08-29T00:00:06.000Z",
    } as never);
  }

  return world;
}

function clueArtifact(): RoomArtifactV2 {
  return { schemaVersion: 2, artifactId: "clue-reversed-score", revision: 1, kind: "clue", title: "倒放的曲序", description: "", body: "从终幕向序曲倒放。", attachments: [], audience: { kind: "room" }, locked: true, archived: false, extensions: {} };
}

function moduleFixture(): ModulePackageV1 {
  return {
    schemaVersion: 1, moduleId: "module-terminal-opus", revision: 1,
    metadata: { title: "通往天国的终幕曲", authors: [], language: "zh-CN", summary: "", createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z" }, overview: "", sourceDocuments: [], chapters: [],
    scenes: [{ id: "scene-source", name: "后台唱片室", description: "KP 秘密", synopsis: "KP 秘密", locationIds: ["location-source"], npcIds: ["npc-source"], clueIds: ["clue-source"], handoutIds: [], suggestedCheckIds: [], keeperNotes: "keeperNotes KP 秘密", sourceRefs: [] }],
    locations: [{ id: "location-source", name: "剧院后门", description: "KP 知道门锁已被调包", playerDescription: "锈蚀的铁门上挂着一道崭新的锁。", aliases: [], sourceRefs: [] }],
    npcs: [{ id: "npc-source", name: "沉默的演员", description: "演员试图掩盖自己的身份", playerDescription: "一个浑身湿透、神情紧张的年轻演员。", role: "目击者", motivation: "KP 秘密动机", traits: ["紧张"], sourceRefs: [] }],
    clues: [{ id: "clue-source", name: "倒放的曲序", description: "KP 才能知道的线索含义", revealText: "曲目必须从终幕向序曲倒放。", isCore: true, sourceRefs: [] }], handouts: [], suggestedChecks: [], keeperNotes: [], relations: [], extensions: {},
  };
}

function twoSceneModuleFixture(): ModulePackageV1 {
  const base = moduleFixture();
  return {
    ...base,
    scenes: [
      ...base.scenes,
      { id: "scene-archive", name: "地下档案室", description: "KP 知道这里有人来过", synopsis: "第二幕", locationIds: ["location-archive"], npcIds: ["npc-archivist"], clueIds: [], handoutIds: [], suggestedCheckIds: [], keeperNotes: "不要提前说出暗门", sourceRefs: [] },
    ],
    locations: [
      ...base.locations,
      { id: "location-archive", name: "积灰铁架", description: "暗门藏在第三排后方", playerDescription: "一排排铁架没入昏暗深处，地上的灰尘留着新鲜拖痕。", aliases: [], sourceRefs: [] },
    ],
    npcs: [
      ...base.npcs,
      { id: "npc-archivist", name: "守夜档案员", description: "他认出了闯入者", playerDescription: "老人攥着钥匙，目光不时飘向第三排铁架。", role: "守夜人", motivation: "保住工作", traits: ["惴惴不安"], sourceRefs: [] },
    ],
  };
}

function floatingClueModuleFixture(): ModulePackageV1 {
  const base = twoSceneModuleFixture();
  const floatingClue = {
    id: "clue-register",
    name: "失踪者登记簿",
    description: "KP 知道失踪者其实使用了假名。",
    revealText: "登记簿显示十七年前有三人在同一个雨夜失踪。",
    isCore: false,
    sourceRefs: [],
  };
  return {
    ...base,
    scenes: base.scenes.map((scene) => scene.id === "scene-archive"
      ? { ...scene, clueIds: [floatingClue.id] }
      : scene),
    clues: [...base.clues, floatingClue],
  };
}
