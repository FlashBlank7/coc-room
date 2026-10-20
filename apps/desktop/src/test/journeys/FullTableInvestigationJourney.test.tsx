// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  EventViewReplicaV2,
  HostEventSequencerV2,
  createRoomCommandV2,
  modulePackageSchema,
  roomCommandV2Schema,
  type AssetDescriptorV1,
  type BoardV1,
  type Coc7Character,
  type RoomEventProposalV2,
  type RoomEventV2,
  type RoomWorldStateV2,
  type SeatV2,
} from "@coc-room/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CheckNegotiationV2,
  CollaborativeBoardCanvas,
  KeeperModuleWorkbenchV2,
  PublicClueBoardV2,
} from "../../components/room/v2";
import {
  detectSceneEntriesV2,
  handleModuleSceneDropV2,
} from "../../components/room/v2/investigation-workspace-helpers";
import type { RoomSessionV2 } from "../../network/RoomSessionV2";
import { RoomViewV2 } from "../../views/RoomViewV2";
import {
  miniHostSeat,
  miniInvestigation,
  miniInvestigator,
  miniModule,
  miniPlayerSeat,
  miniRoomRecord,
} from "../scenarios/mini-investigation";

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

Object.defineProperty(window, "PointerEvent", {
  configurable: true,
  value: TestPointerEvent,
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

const roomAudience = { kind: "room" } as const;
const hostAudience = { kind: "host" } as const;

const privateCanaryTokens = {
  prep: "FTJ_SECRET_PREP_4F82",
  moduleSummary: "FTJ_SECRET_MODULE_SUMMARY_1D31",
  scene: "FTJ_SECRET_SCENE_7A11",
  keeperNotes: "FTJ_SECRET_SCENE_NOTE_9C20",
  moduleKeeperNote: "FTJ_SECRET_MODULE_NOTE_6E44",
  location: "FTJ_SECRET_LOCATION_2B73",
  npc: "FTJ_SECRET_NPC_DESCRIPTION_8D05",
  npcMotivation: "FTJ_SECRET_NPC_MOTIVATION_3A96",
  npcTrait: "FTJ_SECRET_NPC_TRAIT_5C17",
  clue: "FTJ_SECRET_CLUE_MEANING_0E68",
  checkPurpose: "FTJ_SECRET_CHECK_PURPOSE_1A79",
  checkSuccess: "FTJ_SECRET_CHECK_SUCCESS_2B80",
  checkFailure: "FTJ_SECRET_CHECK_FAILURE_3C91",
  sourceRef: "FTJ_SECRET_SOURCE_REF_4DA2",
  relation: "FTJ_SECRET_RELATION_5EB3",
} as const;

const tableStory = {
  opening: "雨幕中的后台唱片室只亮着一盏台灯，转盘仍在空转。",
  location: "积灰的唱片机仍在缓慢旋转，墙上贴着褪色的演出表。",
  npc: "一名穿旧剧院制服的场务靠在门边，神情紧张，不时看向唱片机。",
  action: "我贴近唱片机，检查底座有没有被拆开过的痕迹。",
  consequence: "你在唱片机夹层摸到一张折起的曲目单；上面的顺序明显被人改过。",
  secrets: {
    prep: `${privateCanaryTokens.prep} KP 私密备忘：午夜后不要让场务离开唱片室。`,
    moduleSummary: `${privateCanaryTokens.moduleSummary} 这份模组围绕幕后封印仪式展开。`,
    scene: `${privateCanaryTokens.scene} KP 秘密：唱片机会在午夜召来幕后的幽灵。`,
    keeperNotes: `${privateCanaryTokens.keeperNotes} 主持人笔记：暗门只在倒放终幕曲时开启。`,
    moduleKeeperNote: `${privateCanaryTokens.moduleKeeperNote} 主持人总笔记：不要提前解释终幕曲与封印的关系。`,
    location: `${privateCanaryTokens.location} KP 秘密：墙后的暗门通向封印室。`,
    npc: `${privateCanaryTokens.npc} KP 秘密：场务正在替幕后幽灵掩盖身份。`,
    npcMotivation: `${privateCanaryTokens.npcMotivation} 阻止调查员发现封印室。`,
    npcTrait: `${privateCanaryTokens.npcTrait} 提到终幕曲时会下意识挡住唱片机。`,
    clue: `${privateCanaryTokens.clue} KP 秘密：倒放曲序其实是一段封印仪式。`,
    checkPurpose: `${privateCanaryTokens.checkPurpose} 判断唱片机是否被人动过。`,
    checkSuccess: `${privateCanaryTokens.checkSuccess} 发现夹层中的曲目单。`,
    checkFailure: `${privateCanaryTokens.checkFailure} 只能看出唱片机年代久远，但调查仍可继续。`,
    sourceRef: `${privateCanaryTokens.sourceRef} 原始手稿第七码标明暗门开启顺序。`,
    relation: `${privateCanaryTokens.relation} 倒放曲序会直接解除唱片室后的封印。`,
  },
} as const;

const privateCanaryCorpus = Object.values(tableStory.secrets).join("\n");

const secretSourceRef = {
  sourceId: "source-keeper-manuscript",
  start: 811,
  end: 899,
  excerpt: tableStory.secrets.sourceRef,
} as const;

const companionSeat: SeatV2 = {
  seatId: "seat-companion",
  role: "player",
  displayName: "小遥",
  peerId: "peer-companion",
  extensions: {},
};

const companionInvestigator: Coc7Character = {
  ...miniInvestigator,
  id: "character-doctor",
  ownerPeerId: companionSeat.seatId,
  name: "佐伯遥",
  playerName: companionSeat.displayName,
  occupation: "医生",
  updatedAt: "2026-08-29T00:01:00.000Z",
};

const structuredModule = modulePackageSchema.parse({
  ...miniModule,
  metadata: {
    ...miniModule.metadata,
    title: "通往天国的终幕曲·全桌旅程",
    summary: tableStory.secrets.moduleSummary,
  },
  sourceDocuments: [{
    id: secretSourceRef.sourceId,
    name: "KP 原始终幕手稿",
    mediaType: "text/plain",
  }],
  scenes: miniModule.scenes.map((scene) => ({
    ...scene,
    description: tableStory.secrets.scene,
    synopsis: tableStory.secrets.scene,
    keeperNotes: tableStory.secrets.keeperNotes,
    locationIds: ["location-record-room"],
    npcIds: ["npc-stagehand"],
    suggestedCheckIds: ["check-phonograph"],
    sourceRefs: [secretSourceRef],
  })),
  locations: [{
    id: "location-record-room",
    name: "后台唱片室",
    description: tableStory.secrets.location,
    playerDescription: tableStory.location,
    aliases: [],
    sourceRefs: [secretSourceRef],
  }],
  npcs: [{
    id: "npc-stagehand",
    name: "藤原真一",
    description: tableStory.secrets.npc,
    playerDescription: tableStory.npc,
    role: "剧院场务",
    motivation: tableStory.secrets.npcMotivation,
    traits: [tableStory.secrets.npcTrait, "闪烁其词"],
    sourceRefs: [secretSourceRef],
  }],
  clues: miniModule.clues.map((clue) => ({
    ...clue,
    description: tableStory.secrets.clue,
    sourceRefs: [secretSourceRef],
  })),
  suggestedChecks: [{
    id: "check-phonograph",
    skill: "侦查",
    difficulty: "regular",
    purpose: tableStory.secrets.checkPurpose,
    onSuccess: tableStory.secrets.checkSuccess,
    onFailure: tableStory.secrets.checkFailure,
    sourceRefs: [secretSourceRef],
  }],
  keeperNotes: [{
    id: "keeper-note-seal-order",
    title: "封印开启顺序",
    content: tableStory.secrets.moduleKeeperNote,
    relatedEntityIds: [miniModule.scenes[0]!.id, miniModule.clues[0]!.id],
    sourceRefs: [secretSourceRef],
  }],
  relations: [{
    id: "relation-score-breaks-seal",
    fromEntityId: miniModule.clues[0]!.id,
    toEntityId: miniModule.scenes[0]!.id,
    kind: "keeper-causal-link",
    description: tableStory.secrets.relation,
    sourceRefs: [secretSourceRef],
  }],
});

const publicMapAsset: AssetDescriptorV1 = {
  schemaVersion: 1,
  assetId: `sha256:${"a".repeat(64)}`,
  mediaType: "image/webp",
  byteLength: 4_096,
  width: 1_600,
  height: 900,
};

const secretPrepAsset: AssetDescriptorV1 = {
  schemaVersion: 1,
  assetId: `sha256:${"f".repeat(64)}`,
  mediaType: "image/webp",
  byteLength: 1_024,
  width: 640,
  height: 360,
};

describe("table investigation core (components + V2 protocol; not file import, RoomSession/P2P, or browser E2E)", () => {
  it("sequences map play, a ruled check and one shared clue without publishing KP-only canaries", async () => {
    const authority = new TableJourneyAuthority();

    // A real host-only event is deliberately placed before all public events.
    // Both player replicas must retain its sequence as a redacted placeholder,
    // while its body, event type and asset hash never enter their projections.
    // Every module canary is mirrored into this private note only so the test
    // also proves that redaction preserves host data instead of deleting it;
    // the module package itself remains host-local and is never a room event.
    const privatePrepEvent = authority.commit(miniHostSeat, {
      type: "artifact.upserted",
      audience: hostAudience,
      payload: {
        artifact: {
          schemaVersion: 2,
          artifactId: "artifact-private-prep",
          revision: 1,
          kind: "note",
          title: "KP 开场备忘",
          description: "只在房主备团区显示",
          body: privateCanaryCorpus,
          attachments: [secretPrepAsset],
          audience: hostAudience,
          locked: true,
          archived: false,
          extensions: {},
        },
      },
    });

    // 1. Seed the protocol state produced after a module has been enabled.
    // Module file selection, repository persistence and the enabling UI are
    // outside this component/protocol journey. Only identity crosses here;
    // the complete package remains a host-local workbench input.
    authority.commit(miniHostSeat, {
      type: "module.switched",
      audience: roomAudience,
      payload: {
        moduleId: structuredModule.moduleId,
        revision: structuredModule.revision,
        title: structuredModule.metadata.title,
      },
    });
    expect(authority.aliceWorld.activeModule).toEqual({
      moduleId: structuredModule.moduleId,
      revision: structuredModule.revision,
      title: structuredModule.metadata.title,
    });

    // 2. Seed only the protocol output expected from a managed asset import.
    // File selection, byte storage and transfer are outside this test. The
    // room event carries a SHA-256 descriptor, never Base64 or a local path.
    authority.commit(miniHostSeat, {
      type: "artifact.upserted",
      audience: roomAudience,
      payload: {
        artifact: {
          schemaVersion: 2,
          artifactId: "artifact-map-background",
          revision: 1,
          kind: "map-background",
          title: "剧院平面图",
          description: "由 KP 导入并公开的地图底图",
          body: "",
          attachments: [],
          asset: publicMapAsset,
          audience: roomAudience,
          locked: true,
          archived: false,
          extensions: {},
        },
      },
    });
    const mapBoard: BoardV1 = {
      schemaVersion: 1,
      boardId: "board-theatre-map",
      revision: 1,
      kind: "map",
      name: "剧院调查地图",
      description: "用于表达调查员所处位置，不自动公开剧情。",
      audience: roomAudience,
      logicalSize: { width: 1_600, height: 900 },
      backgroundArtifactId: "artifact-map-background",
      archived: false,
      items: [],
      edges: [],
      extensions: {},
    };
    authority.commit(miniHostSeat, {
      type: "board.created",
      audience: roomAudience,
      payload: { board: mapBoard },
    });
    authority.commit(miniHostSeat, {
      type: "board.activated",
      audience: roomAudience,
      payload: { boardId: mapBoard.boardId },
    });
    expect(authority.aliceWorld.artifacts.get("artifact-map-background")?.asset).toEqual(publicMapAsset);
    expect(authority.aliceWorld.boards.get(mapBoard.boardId)?.backgroundArtifactId).toBe("artifact-map-background");

    // 3. A completed character card enters the room as a real player command.
    // The KP then uses the same scene-drop helper wired by RoomView and places
    // that player's character token. Browser drag/drop plumbing is out of scope.
    authority.commit(miniPlayerSeat, {
      type: "character.updated",
      audience: roomAudience,
      payload: { character: miniInvestigator },
    });

    const sceneDropSubmit = vi.fn().mockResolvedValue("confirmed");
    await handleModuleSceneDropV2(
      mockSession(authority.world, miniHostSeat, sceneDropSubmit),
      structuredModule,
      mapBoard.boardId,
      JSON.stringify({
        kind: "module-scene",
        moduleId: structuredModule.moduleId,
        revision: structuredModule.revision,
        sceneId: structuredModule.scenes[0]!.id,
      }),
      { x: 800, y: 450 },
    );
    expect(sceneDropSubmit).toHaveBeenCalledTimes(2);
    expect(proposalAt(sceneDropSubmit, 0, "entity.upserted").payload.entity).toMatchObject({
      kind: "scene",
      name: "后台唱片室",
      description: "",
    });
    assertNoPrivateCanaries(sceneDropSubmit.mock.calls);
    authority.commitCalls(miniHostSeat, sceneDropSubmit);

    const characterPlacementSubmit = vi.fn().mockResolvedValue("confirmed");
    render(
      <KeeperModuleWorkbenchV2
        modulePackage={structuredModule}
        world={authority.world}
        board={requireBoard(authority.world, mapBoard.boardId)}
        session={mockSession(authority.world, miniHostSeat, characterPlacementSubmit)}
      />,
    );
    for (const canary of [
      privateCanaryTokens.scene,
      privateCanaryTokens.keeperNotes,
      privateCanaryTokens.location,
      privateCanaryTokens.npc,
      privateCanaryTokens.npcMotivation,
      privateCanaryTokens.npcTrait,
      privateCanaryTokens.clue,
      privateCanaryTokens.checkPurpose,
      privateCanaryTokens.checkSuccess,
      privateCanaryTokens.checkFailure,
    ]) {
      expect(document.body.textContent).toContain(canary);
    }
    fireEvent.click(screen.getByRole("button", { name: "放置角色棋子" }));
    await waitFor(() => expect(characterPlacementSubmit).toHaveBeenCalledTimes(2));
    authority.commitCalls(miniHostSeat, characterPlacementSubmit);
    cleanup();

    // The companion needs both a room character and a map token. Besides
    // supporting the later independent clue mark, the foreign token is the
    // negative control for Alice's map-movement ownership boundary.
    authority.commit(companionSeat, {
      type: "character.updated",
      audience: roomAudience,
      payload: { character: companionInvestigator },
    });

    const companionPlacementSubmit = vi.fn().mockResolvedValue("confirmed");
    render(
      <KeeperModuleWorkbenchV2
        modulePackage={structuredModule}
        world={authority.world}
        board={requireBoard(authority.world, mapBoard.boardId)}
        session={mockSession(authority.world, miniHostSeat, companionPlacementSubmit)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "放置角色棋子" }));
    await waitFor(() => expect(companionPlacementSubmit).toHaveBeenCalledTimes(2));
    expect(proposalAt(companionPlacementSubmit, 0, "entity.upserted").payload.entity).toMatchObject({
      kind: "character",
      name: companionInvestigator.name,
      data: {
        characterId: companionInvestigator.id,
        ownerSeatId: companionSeat.seatId,
      },
    });
    authority.commitCalls(miniHostSeat, companionPlacementSubmit);
    cleanup();

    // 4. The rendered room exposes Bob's token as view-only to Alice and emits
    // no proposal when she tries to drag it. Her own token remains movable and
    // emits one final board update, which is then sequenced authoritatively.
    const playerMoveSubmit = vi.fn().mockResolvedValue("confirmed");
    renderRoom(authority.aliceWorld, miniPlayerSeat, playerMoveSubmit, authority.aliceViews);
    fireEvent.click(screen.getByRole("button", { name: "展开画面：剧院调查地图" }));
    const mapCanvas = screen.getByRole("group", { name: "剧院调查地图 画面内容" });
    mockCanvasBounds(mapCanvas);
    const companionToken = screen.getByRole("button", { name: `${companionInvestigator.name}（只能查看）` });
    fireEvent.pointerDown(companionToken, { pointerId: 6, button: 0, clientX: 240, clientY: 770 });
    fireEvent.pointerMove(mapCanvas, { pointerId: 6, clientX: 900, clientY: 400 });
    fireEvent.pointerUp(mapCanvas, { pointerId: 6, clientX: 900, clientY: 400 });
    expect(playerMoveSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("你可以查看这项内容，但不能移动它。")).toBeTruthy();
    expect(screen.queryByLabelText(`移动 ${companionInvestigator.name}`)).toBeNull();

    const ownToken = screen.getByRole("button", { name: miniInvestigator.name });
    fireEvent.pointerDown(ownToken, { pointerId: 7, button: 0, clientX: 120, clientY: 770 });
    fireEvent.pointerMove(mapCanvas, { pointerId: 7, clientX: 800, clientY: 450 });
    fireEvent.pointerUp(mapCanvas, { pointerId: 7, clientX: 800, clientY: 450 });

    await waitFor(() => expect(playerMoveSubmit).toHaveBeenCalledTimes(1));
    const movementProposal = proposalAt(playerMoveSubmit, 0, "board.item.upserted");
    expect(movementProposal.payload.item).toMatchObject({
      label: miniInvestigator.name,
      position: { x: 800, y: 450 },
    });
    authority.commit(miniPlayerSeat, movementProposal);
    cleanup();

    const sceneEntries = detectSceneEntriesV2(
      authority.aliceWorld,
      requireBoard(authority.aliceWorld, mapBoard.boardId),
    );
    expect(sceneEntries).toHaveLength(1);
    expect(sceneEntries[0]?.scene.name).toBe("后台唱片室");
    expect(sceneEntries[0]?.characters.map(({ entity }) => entity.name)).toEqual([miniInvestigator.name]);

    // 5. Entry is only a positional signal. The KP explicitly publishes the
    // public scene description, then the location and NPC summaries. The NPC is
    // independently placed on the map; none of the module's private prose is sent.
    const presentationSubmit = vi.fn().mockResolvedValue("confirmed");
    render(
      <KeeperModuleWorkbenchV2
        modulePackage={structuredModule}
        world={authority.world}
        board={requireBoard(authority.world, mapBoard.boardId)}
        session={mockSession(authority.world, miniHostSeat, presentationSubmit)}
      />,
    );
    expect(screen.getByLabelText("调查员进入了另一个场景").textContent).toContain(miniInvestigator.name);
    await waitFor(() => expect(screen.getByLabelText("玩家可见的开场描述").hasAttribute("disabled")).toBe(false));
    fireEvent.change(screen.getByLabelText("玩家可见的开场描述"), {
      target: { value: tableStory.opening },
    });
    fireEvent.click(screen.getByRole("button", { name: "向所有人呈现这个场景" }));
    await waitFor(() => expect(presentationSubmit).toHaveBeenCalledTimes(2));
    assertNoPrivateCanaries(presentationSubmit.mock.calls);
    authority.commitCalls(miniHostSeat, presentationSubmit);
    cleanup();

    const locationSubmit = vi.fn().mockResolvedValue("confirmed");
    render(
      <KeeperModuleWorkbenchV2
        modulePackage={structuredModule}
        world={authority.world}
        board={requireBoard(authority.world, mapBoard.boardId)}
        session={mockSession(authority.world, miniHostSeat, locationSubmit)}
      />,
    );
    await waitFor(() => expect((screen.getByLabelText(`玩家可见介绍：${structuredModule.locations[0]!.name}`) as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText(`玩家可见介绍：${structuredModule.locations[0]!.name}`), { target: { value: structuredModule.locations[0]!.playerDescription } });
    fireEvent.click(screen.getByRole("button", { name: "让地点在当前情境登场" }));
    await waitFor(() => expect(locationSubmit).toHaveBeenCalledOnce());
    expect(serializedCalls(locationSubmit)).toContain(tableStory.location);
    assertNoPrivateCanaries(locationSubmit.mock.calls);
    authority.commitCalls(miniHostSeat, locationSubmit);
    cleanup();

    // Publishing an NPC and placing a visual token are separate choices. The
    // public summary reaches the room first; no map mutation is implicit.
    const npcSubmit = vi.fn().mockResolvedValue("confirmed");
    render(
      <KeeperModuleWorkbenchV2
        modulePackage={structuredModule}
        world={authority.world}
        board={requireBoard(authority.world, mapBoard.boardId)}
        session={mockSession(authority.world, miniHostSeat, npcSubmit)}
      />,
    );
    await waitFor(() => expect((screen.getByLabelText(`玩家可见介绍：${structuredModule.npcs[0]!.name}`) as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText(`玩家可见介绍：${structuredModule.npcs[0]!.name}`), { target: { value: structuredModule.npcs[0]!.playerDescription } });
    fireEvent.click(screen.getByRole("button", { name: "让 NPC 在当前情境登场" }));
    await waitFor(() => expect(npcSubmit).toHaveBeenCalledOnce());
    expect(serializedCalls(npcSubmit)).toContain(tableStory.npc);
    expect(serializedCalls(npcSubmit)).not.toContain("board.item.upserted");
    assertNoPrivateCanaries(npcSubmit.mock.calls);
    authority.commitCalls(miniHostSeat, npcSubmit);
    cleanup();

    const npcPlacementSubmit = vi.fn().mockResolvedValue("confirmed");
    render(
      <KeeperModuleWorkbenchV2
        modulePackage={structuredModule}
        world={authority.world}
        board={requireBoard(authority.world, mapBoard.boardId)}
        session={mockSession(authority.world, miniHostSeat, npcPlacementSubmit)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "放一个 NPC 棋子到当前画面" }));
    await waitFor(() => expect(npcPlacementSubmit).toHaveBeenCalledTimes(1));
    expect(proposalAt(npcPlacementSubmit, 0, "board.item.upserted").payload.item.reference).toMatchObject({ kind: "entity" });
    authority.commitCalls(miniHostSeat, npcPlacementSubmit);
    cleanup();

    renderRoom(authority.aliceWorld, miniPlayerSeat, vi.fn().mockResolvedValue("confirmed"), authority.aliceViews);
    const currentSituation = screen.getByLabelText("当前情境");
    expect(within(currentSituation).getByText(tableStory.opening)).toBeTruthy();
    expect(within(currentSituation).getByText(tableStory.location)).toBeTruthy();
    expect(within(currentSituation).getByText(tableStory.npc)).toBeTruthy();
    assertNoPrivateCanaries(document.body.textContent);
    cleanup();

    // Resolve the already-managed background URL at the rendering boundary.
    // The board receives a URL only after descriptor lookup; no image bytes are
    // embedded in protocol state by this component-level journey.
    render(
      <CollaborativeBoardCanvas
        board={requireBoard(authority.aliceWorld, mapBoard.boardId)}
        backgroundUrl={`https://assets.invalid/${publicMapAsset.assetId.slice("sha256:".length)}.webp`}
        readOnly
      />,
    );
    const renderedBackground = screen.getByRole("img", { name: "画面背景：剧院调查地图" });
    expect(renderedBackground.getAttribute("src")).toContain(publicMapAsset.assetId.slice("sha256:".length));
    cleanup();

    // 6. The player describes intent in natural language. The KP authorizes
    // the character-sheet value, and the real host sequencer rolls a fixed
    // successful d100 result rather than accepting a client-authored result.
    const requestSubmit = vi.fn().mockResolvedValue("confirmed");
    render(
      <CheckNegotiationV2
        world={authority.aliceWorld}
        session={mockSession(authority.aliceWorld, miniPlayerSeat, requestSubmit)}
      />,
    );
    fireEvent.change(screen.getByLabelText("行动目标"), { target: { value: "确认唱片机的异常来源" } });
    fireEvent.change(screen.getByLabelText("你想怎么做"), { target: { value: tableStory.action } });
    fireEvent.change(screen.getByLabelText("使用技能或属性"), { target: { value: "skill:skill-spot" } });
    fireEvent.click(screen.getByRole("button", { name: "提交行动，请 KP 裁定" }));
    await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));
    const requestProposal = proposalAt(requestSubmit, 0, "check.requested");
    expect(requestProposal).toMatchObject({
      audience: roomAudience,
      payload: {
        characterId: miniInvestigator.id,
        characterName: miniInvestigator.name,
        skillName: "侦查",
        proposedTarget: 60,
        reason: tableStory.action,
        goal: "确认唱片机的异常来源",
        approach: tableStory.action,
        suggestedSkillName: "侦查",
      },
    });
    authority.commit(miniPlayerSeat, requestProposal);
    cleanup();

    const authorizeSubmit = vi.fn().mockResolvedValue("confirmed");
    render(
      <CheckNegotiationV2
        world={authority.world}
        session={mockSession(authority.world, miniHostSeat, authorizeSubmit)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "需要检定" }));
    fireEvent.click(screen.getByRole("button", { name: "需要普通检定" }));
    await waitFor(() => expect(authorizeSubmit).toHaveBeenCalledTimes(1));
    const authorizationProposal = proposalAt(authorizeSubmit, 0, "check.authorized");
    expect(authorizationProposal).toMatchObject({
      audience: roomAudience,
      payload: {
        requestId: requestProposal.payload.requestId,
        skillName: "侦查",
        target: 60,
        requiredDifficulty: "regular",
        bonusDice: 0,
        penaltyDice: 0,
      },
    });
    authority.commit(miniHostSeat, authorizationProposal);
    cleanup();

    let rollEvent: RoomEventV2 | undefined;
    const rollDice = vi.fn(async (payload: Parameters<RoomSessionV2["rollDice"]>[0]) => {
      rollEvent = authority.roll(miniPlayerSeat, payload);
      return rollEvent.eventId;
    });
    render(
      <CheckNegotiationV2
        world={authority.aliceWorld}
        session={mockSession(authority.aliceWorld, miniPlayerSeat, vi.fn().mockResolvedValue("confirmed"), rollDice)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "掷骰：侦查（60）" }));
    await waitFor(() => expect(rollDice).toHaveBeenCalledTimes(1));
    expect(rollEvent).toMatchObject({
      type: "dice.result",
      payload: {
        checkRequestId: requestProposal.payload.requestId,
        result: { total: 24, check: { success: true } },
      },
    });
    cleanup();

    // The table may narrate through voice or chat. A separate outcome record
    // remains available without blocking the next ordinary action.
    renderRoom(authority.aliceWorld, miniPlayerSeat, vi.fn().mockResolvedValue("confirmed"), authority.aliceViews);
    expect(screen.getByRole("heading", { name: "检定已完成，可以继续行动" })).toBeTruthy();
    expect(screen.getByLabelText("你想怎么做")).toBeTruthy();
    cleanup();

    const consequenceSubmit = vi.fn().mockResolvedValue("confirmed");
    renderRoom(authority.world, miniHostSeat, consequenceSubmit, authority.hostViews);
    expect(screen.getByRole("heading", { name: /描述 .* 这次成功带来的变化/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^检定叙述结果：/), {
      target: { value: tableStory.consequence },
    });
    fireEvent.click(screen.getByRole("button", { name: "发布这次叙述结果" }));
    await waitFor(() => expect(consequenceSubmit).toHaveBeenCalledTimes(1));
    const consequenceProposal = proposalAt(consequenceSubmit, 0, "check.outcome.described");
    expect(consequenceProposal.payload).toEqual({
      requestId: requestProposal.payload.requestId,
      text: tableStory.consequence,
    });
    authority.commit(miniHostSeat, consequenceProposal);
    cleanup();

    renderRoom(authority.aliceWorld, miniPlayerSeat, vi.fn().mockResolvedValue("confirmed"), authority.aliceViews);
    expect(screen.getByText(tableStory.consequence)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "你想怎么做？" })).toBeTruthy();
    cleanup();

    // 7. Only after narrating the successful consequence does KP release the
    // related player-facing clue into the shared case file.
    const clueSubmit = vi.fn().mockResolvedValue("confirmed");
    render(
      <KeeperModuleWorkbenchV2
        modulePackage={structuredModule}
        world={authority.world}
        board={requireBoard(authority.world, mapBoard.boardId)}
        session={mockSession(authority.world, miniHostSeat, clueSubmit)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "公开到调查案卷" }));
    await waitFor(() => expect(clueSubmit).toHaveBeenCalledTimes(1));
    const clueProposal = proposalAt(clueSubmit, 0, "artifact.upserted");
    expect(clueProposal).toMatchObject({
      audience: roomAudience,
      payload: {
        artifact: {
          kind: "clue",
          title: "倒放的曲序",
          description: "",
          body: miniInvestigation.publicClueText,
        },
      },
    });
    assertNoPrivateCanaries(clueSubmit.mock.calls);
    authority.commit(miniHostSeat, clueProposal);
    cleanup();

    // The evidence board is independent of the active scene map. It remains an
    // optional shared view and starts with no duplicate copy of the clue.
    const evidenceBoard: BoardV1 = {
      schemaVersion: 1,
      boardId: "board-shared-evidence",
      revision: 1,
      kind: "evidence",
      name: "共同推理板",
      description: "公开线索的关系图",
      audience: roomAudience,
      logicalSize: { width: 1_600, height: 900 },
      archived: false,
      items: [],
      edges: [],
      extensions: {},
    };
    authority.commit(miniHostSeat, {
      type: "board.created",
      audience: roomAudience,
      payload: { board: evidenceBoard },
    });
    expect(authority.world.activeBoardId).toBe(mapBoard.boardId);

    // 8. Alice marks the clue for her character, then places the same public
    // artifact on the shared reasoning board. Neither action creates a copy.
    const aliceClaimSubmit = vi.fn().mockResolvedValue("confirmed");
    render(
      <PublicClueBoardV2
        world={authority.aliceWorld}
        board={requireBoard(authority.aliceWorld, evidenceBoard.boardId)}
        session={mockSession(authority.aliceWorld, miniPlayerSeat, aliceClaimSubmit)}
      />,
    );
    expect(within(screen.getByLabelText("调查案卷")).getAllByText(miniInvestigation.publicClueText)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "加入我的线索栏" }));
    await waitFor(() => expect(aliceClaimSubmit).toHaveBeenCalledTimes(1));
    const aliceClaimProposal = proposalAt(aliceClaimSubmit, 0, "clue.claimed");
    authority.commit(miniPlayerSeat, aliceClaimProposal);
    cleanup();

    const evidencePlacementSubmit = vi.fn().mockResolvedValue("confirmed");
    render(
      <PublicClueBoardV2
        world={authority.aliceWorld}
        board={requireBoard(authority.aliceWorld, evidenceBoard.boardId)}
        session={mockSession(authority.aliceWorld, miniPlayerSeat, evidencePlacementSubmit)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "放到大家的推理板" }));
    await waitFor(() => expect(evidencePlacementSubmit).toHaveBeenCalledTimes(1));
    const evidencePlacementProposal = proposalAt(evidencePlacementSubmit, 0, "board.item.upserted");
    expect(evidencePlacementProposal.payload.item.reference).toEqual({
      kind: "artifact",
      artifactId: clueProposal.payload.artifact.artifactId,
    });
    authority.commit(miniPlayerSeat, evidencePlacementProposal);
    cleanup();

    // 9. A second player independently marks the same clue. The existing
    // reasoning-board item is visible but cannot be added a second time.
    const companionClaimSubmit = vi.fn().mockResolvedValue("confirmed");
    render(
      <PublicClueBoardV2
        world={authority.companionWorld}
        board={requireBoard(authority.companionWorld, evidenceBoard.boardId)}
        session={mockSession(authority.companionWorld, companionSeat, companionClaimSubmit)}
      />,
    );
    expect((screen.getByRole("button", { name: "已放到大家的推理板" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "加入我的线索栏" }));
    await waitFor(() => expect(companionClaimSubmit).toHaveBeenCalledTimes(1));
    const companionClaimProposal = proposalAt(companionClaimSubmit, 0, "clue.claimed");
    authority.commit(companionSeat, companionClaimProposal);
    cleanup();

    const publicClues = [...authority.world.artifacts.values()].filter((artifact) => artifact.kind === "clue" && artifact.audience.kind === "room");
    expect(publicClues).toHaveLength(1);
    expect(authority.world.clueClaims.get(clueProposal.payload.artifact.artifactId)).toMatchObject([
      { seatId: miniPlayerSeat.seatId, characterId: miniInvestigator.id, characterName: miniInvestigator.name },
      { seatId: companionSeat.seatId, characterId: companionInvestigator.id, characterName: companionInvestigator.name },
    ]);
    const finalEvidenceBoard = requireBoard(authority.aliceWorld, evidenceBoard.boardId);
    expect(finalEvidenceBoard.items).toHaveLength(1);
    expect(finalEvidenceBoard.items[0]?.reference).toEqual({
      kind: "artifact",
      artifactId: clueProposal.payload.artifact.artifactId,
    });
    expect(authority.aliceWorld.activeBoardId).toBe(mapBoard.boardId);

    render(
      <PublicClueBoardV2
        world={authority.aliceWorld}
        board={finalEvidenceBoard}
        session={mockSession(authority.aliceWorld, miniPlayerSeat, vi.fn().mockResolvedValue("confirmed"))}
      />,
    );
    const sharedCaseFile = screen.getByLabelText("调查案卷");
    expect(within(sharedCaseFile).getAllByText(miniInvestigation.publicClueText)).toHaveLength(1);
    expect(within(sharedCaseFile).getByText(/林默、佐伯遥/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "我的重点" }));
    expect(within(screen.getByLabelText("我的重点列表")).getAllByText(miniInvestigation.publicClueText)).toHaveLength(1);
    cleanup();

    render(
      <CollaborativeBoardCanvas
        board={finalEvidenceBoard}
        artifacts={authority.aliceWorld.artifacts}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "倒放的曲序" }));
    const selectedClue = screen.getByLabelText("选中的公开资料");
    expect(within(selectedClue).getByText(miniInvestigation.publicClueText)).toBeTruthy();

    // 10. Both replicas consumed one continuous sequence, but the first event
    // stayed redacted. Every independent KP canary is absent from both players'
    // serialized views and derived worlds, while the host's full view/world
    // retains the complete private note and asset descriptor.
    expect(authority.aliceLastSequence).toBe(authority.world.lastSequence);
    expect(authority.companionLastSequence).toBe(authority.world.lastSequence);
    expect(authority.aliceViews).toHaveLength(authority.world.lastSequence);
    expect(authority.companionViews).toHaveLength(authority.world.lastSequence);
    assertRedactedPrivateEvent(authority.aliceViews, privatePrepEvent.sequence);
    assertRedactedPrivateEvent(authority.companionViews, privatePrepEvent.sequence);
    expect(authority.aliceWorld.artifacts.has("artifact-private-prep")).toBe(false);
    expect(authority.companionWorld.artifacts.has("artifact-private-prep")).toBe(false);

    for (const playerViews of [authority.aliceViews, authority.companionViews]) {
      const projection = serializedInspectable(playerViews);
      assertNoPrivateCanaries(playerViews);
      expect(projection).not.toContain(secretPrepAsset.assetId);
      expect(projection).toContain(publicMapAsset.assetId);
      expect(projection).toContain(miniInvestigation.publicClueText);
    }

    for (const playerWorld of [authority.aliceWorld, authority.companionWorld]) {
      const projection = serializedInspectable(playerWorld);
      assertNoPrivateCanaries(playerWorld);
      expect(projection).not.toContain(secretPrepAsset.assetId);
      expect(projection).toContain(publicMapAsset.assetId);
      expect(projection).toContain(miniInvestigation.publicClueText);
    }

    const hostPrivateArtifact = authority.world.artifacts.get("artifact-private-prep");
    expect(hostPrivateArtifact?.body).toBe(privateCanaryCorpus);
    expect(hostPrivateArtifact?.attachments).toContainEqual(secretPrepAsset);
    assertContainsPrivateCanaries(authority.hostViews);
    assertContainsPrivateCanaries(authority.world);
    expect(serializedInspectable(authority.hostViews)).toContain(secretPrepAsset.assetId);
    expect(serializedInspectable(authority.world)).toContain(secretPrepAsset.assetId);
  }, 30_000);
});

class TableJourneyAuthority {
  private readonly sequencer: HostEventSequencerV2;
  private readonly aliceReplica = new EventViewReplicaV2(miniInvestigation.roomId);
  private readonly companionReplica = new EventViewReplicaV2(miniInvestigation.roomId);

  constructor() {
    let eventId = 0;
    const randomValues = [4, 2];
    this.sequencer = new HostEventSequencerV2(miniInvestigation.roomId, {
      createEventId: () => `70000000-0000-4000-8000-${String(++eventId).padStart(12, "0")}`,
      clock: () => new Date("2026-08-29T00:00:00.000Z"),
      rng: () => randomValues.shift() ?? 0,
    });
  }

  get world(): RoomWorldStateV2 {
    return this.sequencer.world;
  }

  get aliceWorld(): RoomWorldStateV2 {
    return this.aliceReplica.deriveWorld();
  }

  get companionWorld(): RoomWorldStateV2 {
    return this.companionReplica.deriveWorld();
  }

  get aliceViews() {
    return this.aliceReplica.orderedViews();
  }

  get companionViews() {
    return this.companionReplica.orderedViews();
  }

  get hostViews() {
    return this.sequencer.viewsAfter(miniHostSeat, 0);
  }

  get aliceLastSequence(): number {
    return this.aliceReplica.lastContiguousSequence;
  }

  get companionLastSequence(): number {
    return this.companionReplica.lastContiguousSequence;
  }

  commit(sender: SeatV2, proposal: RoomEventProposalV2): RoomEventV2 {
    const event = this.sequencer.commitCommand(
      createRoomCommandV2(miniInvestigation.roomId, sender, proposal),
      sender,
    ).event;
    this.syncPlayers();
    return event;
  }

  roll(sender: SeatV2, payload: Parameters<RoomSessionV2["rollDice"]>[0]): RoomEventV2 {
    const event = this.sequencer.commitCommand(roomCommandV2Schema.parse({
      protocolVersion: 2,
      roomId: miniInvestigation.roomId,
      commandId: crypto.randomUUID(),
      sender,
      sentAt: "2026-08-29T00:00:00.000Z",
      type: "dice.roll",
      audience: roomAudience,
      payload,
    }), sender).event;
    this.syncPlayers();
    return event;
  }

  commitCalls(sender: SeatV2, submit: ReturnType<typeof vi.fn>): void {
    for (const [proposal] of submit.mock.calls) {
      this.commit(sender, proposal as RoomEventProposalV2);
    }
  }

  private syncPlayers(): void {
    for (const [seat, replica] of [
      [miniPlayerSeat, this.aliceReplica],
      [companionSeat, this.companionReplica],
    ] as const) {
      for (const view of this.sequencer.viewsAfter(seat, replica.lastContiguousSequence)) {
        replica.apply(view);
      }
    }
  }
}

function mockSession(
  world: RoomWorldStateV2,
  localSeat: SeatV2,
  submit: ReturnType<typeof vi.fn>,
  rollDice: ReturnType<typeof vi.fn> = vi.fn(),
): RoomSessionV2 {
  return {
    world,
    localSeat,
    isHost: localSeat.role === "host",
    isAuthenticated: true,
    submit,
    submitConfirmed: submit,
    rollDice,
    sendPreview: vi.fn(),
  } as unknown as RoomSessionV2;
}

function renderRoom(
  world: RoomWorldStateV2,
  localSeat: SeatV2,
  submit: ReturnType<typeof vi.fn>,
  views: ReturnType<EventViewReplicaV2["orderedViews"]>,
) {
  return render(
    <RoomViewV2
      room={miniRoomRecord(localSeat.role)}
      session={mockSession(world, localSeat, submit)}
      views={views}
      world={world}
      seats={[miniHostSeat, miniPlayerSeat, companionSeat]}
      paths={{}}
      authenticationState="authenticated"
      setConnectionError={vi.fn()}
      onLeave={vi.fn()}
    />,
  );
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

function requireBoard(world: RoomWorldStateV2, boardId: string): BoardV1 {
  const board = world.boards.get(boardId);
  expect(board).toBeDefined();
  return board!;
}

function serializedCalls(mock: ReturnType<typeof vi.fn>): string {
  return JSON.stringify(mock.mock.calls);
}

function serializedInspectable(value: unknown): string {
  return JSON.stringify(value, (_key, candidate) => (
    candidate instanceof Map ? [...candidate.entries()] : candidate
  ));
}

function assertNoPrivateCanaries(value: unknown): void {
  const serialized = serializedInspectable(value);
  for (const canary of Object.values(privateCanaryTokens)) {
    expect(serialized).not.toContain(canary);
  }
}

function assertContainsPrivateCanaries(value: unknown): void {
  const serialized = serializedInspectable(value);
  for (const canary of Object.values(privateCanaryTokens)) {
    expect(serialized).toContain(canary);
  }
}

function mockCanvasBounds(element: HTMLElement): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1_600,
    bottom: 900,
    width: 1_600,
    height: 900,
    toJSON: () => ({}),
  });
}

function assertRedactedPrivateEvent(
  views: ReturnType<EventViewReplicaV2["orderedViews"]>,
  sequence: number,
): void {
  const privateView = views.find((view) => (
    view.view === "full" ? view.event.sequence : view.sequence
  ) === sequence);
  expect(privateView).toBeDefined();
  expect(privateView?.view).toBe("redacted");
  expect(privateView && "type" in privateView).toBe(false);
  expect(privateView && "payload" in privateView).toBe(false);
  expect(privateView && "audience" in privateView).toBe(false);
}
