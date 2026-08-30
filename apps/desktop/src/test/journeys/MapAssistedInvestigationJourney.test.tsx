// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  EventViewReplicaV2,
  HostEventSequencerV2,
  createRoomCommandV2,
  type BoardItemV1,
  type ModulePackageV1,
  type RoomEntityV2,
  type RoomEventProposalV2,
  type RoomWorldStateV2,
  type SeatV2,
} from "@coc-room/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KeeperModuleWorkbenchV2,
} from "../../components/room/v2/InvestigationWorkspaceV2";
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

afterEach(cleanup);

const roomAudience = { kind: "room" } as const;
const mapInvestigation = {
  publicOpening: "雨幕中的唱片室只亮着一盏台灯，转盘仍在空转。",
  publicLocation: "积灰的唱片机仍在缓慢旋转，墙上贴着褪色的演出表。",
  publicNpc: "一名穿旧剧院制服的场务靠在门边，神情紧张，不时看向唱片机。",
  secrets: {
    location: "KP 秘密：墙后的暗门通向封印室。",
    npc: "KP 秘密：场务正在替幕后幽灵掩盖身份。",
  },
} as const;

const otherPlayerSeat: SeatV2 = {
  seatId: "seat-other-player",
  role: "player",
  displayName: "另一位玩家",
  peerId: "peer-other-player",
  extensions: {},
};

const mapModule: ModulePackageV1 = {
  ...miniModule,
  metadata: {
    ...miniModule.metadata,
    summary: "带可选地图、公开地点和 NPC 的微型调查。",
  },
  scenes: miniModule.scenes.map((scene) => ({
    ...scene,
    locationIds: ["location-record-room"],
    npcIds: ["npc-stagehand"],
  })),
  locations: [
    {
      id: "location-record-room",
      name: "后台唱片室",
      description: mapInvestigation.secrets.location,
      playerDescription: mapInvestigation.publicLocation,
      aliases: [],
      sourceRefs: [],
    },
  ],
  npcs: [
    {
      id: "npc-stagehand",
      name: "藤原真一",
      description: mapInvestigation.secrets.npc,
      playerDescription: mapInvestigation.publicNpc,
      role: "剧院场务",
      motivation: "阻止调查员发现封印室。",
      traits: ["紧张", "闪烁其词"],
      sourceRefs: [],
    },
  ],
};

describe("segmented task journey: map-assisted investigation (not browser E2E)", () => {
  it("carries UI proposals through host sequencing into the player's durable map and scene view", async () => {
    const authority = new MapJourneyAuthority();

    // 1. The KP creates and activates a map from the room's optional visual
    // aid prompt. The two proposals still have to pass the real host
    // sequencer; this is a component/protocol journey, not a browser E2E.
    const boardSubmit = vi.fn().mockResolvedValue("submitted");
    renderRoom(authority.world, miniHostSeat, boardSubmit);
    fireEvent.change(screen.getByLabelText("画面类型"), { target: { value: "map" } });
    fireEvent.click(screen.getByRole("button", { name: "创建可选画面" }));

    await waitFor(() => expect(boardSubmit).toHaveBeenCalledTimes(2));
    const boardCreated = proposalAt(boardSubmit, 0, "board.created");
    const boardActivated = proposalAt(boardSubmit, 1, "board.activated");
    expect(boardCreated.payload.board.kind).toBe("map");
    expect(boardActivated.payload.boardId).toBe(boardCreated.payload.board.boardId);
    authority.commitCalls(miniHostSeat, boardSubmit);
    cleanup();

    authority.commit(miniHostSeat, {
      type: "module.switched",
      audience: roomAudience,
      payload: {
        moduleId: mapModule.moduleId,
        revision: mapModule.revision,
        title: mapModule.metadata.title,
      },
    });
    authority.commit(miniPlayerSeat, {
      type: "character.updated",
      audience: roomAudience,
      payload: { character: miniInvestigator },
    });

    const boardId = boardCreated.payload.board.boardId;
    let board = requireBoard(authority.world, boardId);

    // 2. A production drop helper turns the private module scene into a
    // deliberately text-free room entity and an unlocked scene zone. The
    // unlocked state lets the KP correct an imprecise drop immediately;
    // room authorization still prevents players from moving the zone.
    const sceneDropSubmit = vi.fn().mockResolvedValue("confirmed");
    await handleModuleSceneDropV2(
      mockSession(authority.world, miniHostSeat, sceneDropSubmit),
      mapModule,
      boardId,
      JSON.stringify({
        kind: "module-scene",
        moduleId: mapModule.moduleId,
        revision: mapModule.revision,
        sceneId: mapModule.scenes[0]!.id,
      }),
      { x: 800, y: 450 },
    );

    expect(sceneDropSubmit).toHaveBeenCalledTimes(2);
    const droppedScene = proposalAt(sceneDropSubmit, 0, "entity.upserted");
    expect(droppedScene.payload.entity).toMatchObject({
      kind: "scene",
      name: "后台唱片室",
      description: "",
    });
    const droppedSceneItem = proposalAt(sceneDropSubmit, 1, "board.item.upserted");
    expect(droppedSceneItem.payload.item).toMatchObject({
      reference: { kind: "entity", entityId: droppedScene.payload.entity.entityId },
      position: { x: 800, y: 450 },
      locked: false,
    });
    expect(serializedCalls(sceneDropSubmit)).not.toContain(miniInvestigation.secrets.sceneSynopsis);
    expect(serializedCalls(sceneDropSubmit)).not.toContain(miniInvestigation.secrets.keeperNotes);
    authority.commitCalls(miniHostSeat, sceneDropSubmit);

    // The KP can nudge the newly dropped scene zone before explicitly
    // locking it. This exercises the real canvas-to-room proposal path.
    const keeperSceneMoveSubmit = vi.fn().mockResolvedValue("confirmed");
    renderRoom(authority.world, miniHostSeat, keeperSceneMoveSubmit);
    fireEvent.click(screen.getByRole("button", { name: "展开画面：新的调查地图" }));
    fireEvent.keyDown(screen.getByTestId(`board-item-${droppedSceneItem.payload.item.itemId}`), {
      key: "ArrowRight",
    });
    await waitFor(() => expect(keeperSceneMoveSubmit).toHaveBeenCalledTimes(1));
    expect(proposalAt(keeperSceneMoveSubmit, 0, "board.item.upserted").payload.item).toMatchObject({
      itemId: droppedSceneItem.payload.item.itemId,
      position: { x: 820, y: 450 },
      locked: false,
    });
    authority.commitCalls(miniHostSeat, keeperSceneMoveSubmit);
    cleanup();

    // 3. The KP places the player's saved character card as a map token via
    // the visible workbench action.
    board = requireBoard(authority.world, boardId);
    const characterPlacementSubmit = vi.fn().mockResolvedValue("confirmed");
    render(
      <KeeperModuleWorkbenchV2
        modulePackage={mapModule}
        world={authority.world}
        board={board}
        session={mockSession(authority.world, miniHostSeat, characterPlacementSubmit)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "放置角色棋子" }));
    await waitFor(() => expect(characterPlacementSubmit).toHaveBeenCalledTimes(2));
    authority.commitCalls(miniHostSeat, characterPlacementSubmit);
    cleanup();

    // Add a second investigator to prove the UI ownership rule is narrower
    // than merely "any character token".
    const otherCharacterEntity: RoomEntityV2 = {
      schemaVersion: 2,
      entityId: "entity-other-investigator",
      revision: 1,
      kind: "character",
      name: "佐伯遥",
      description: "医生",
      artifactIds: [],
      audience: roomAudience,
      data: {
        characterId: "character-other-investigator",
        ownerSeatId: otherPlayerSeat.seatId,
        roomRole: "character-token",
      },
      extensions: {},
    };
    authority.commit(miniHostSeat, {
      type: "entity.upserted",
      audience: roomAudience,
      payload: { entity: otherCharacterEntity },
    });
    board = requireBoard(authority.world, boardId);
    authority.commit(miniHostSeat, {
      type: "board.item.upserted",
      audience: roomAudience,
      payload: {
        boardId,
        boardRevision: board.revision + 1,
        item: entityBoardItem(
          "item-other-investigator",
          otherCharacterEntity,
          { x: 300, y: 720 },
          { width: 130, height: 130 },
        ),
      },
    });

    // 4. In the player's real RoomView, only their own token is draggable.
    // One completed pointer gesture becomes one proposal, then the host
    // sequencer accepts it and the player's replica reconstructs the entry.
    const playerMoveSubmit = vi.fn().mockResolvedValue("submitted");
    renderRoom(authority.playerWorld, miniPlayerSeat, playerMoveSubmit, authority.playerViews);
    fireEvent.click(screen.getByRole("button", { name: "展开画面：新的调查地图" }));
    const canvas = screen.getByRole("group", { name: "新的调查地图 画面内容" });
    mockCanvasBounds(canvas);
    const ownToken = screen.getByRole("button", { name: miniInvestigator.name });
    const otherToken = screen.getByRole("button", { name: `${otherCharacterEntity.name}（只能查看）` });
    const sceneZone = screen.getByTestId(`board-item-${droppedSceneItem.payload.item.itemId}`);

    expect(sceneZone.getAttribute("aria-label")).toContain("只能查看");
    fireEvent.pointerDown(sceneZone, { pointerId: 2, button: 0, clientX: 820, clientY: 450 });
    fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 980, clientY: 540 });
    fireEvent.pointerUp(canvas, { pointerId: 2, clientX: 980, clientY: 540 });
    fireEvent.keyDown(sceneZone, { key: "ArrowRight" });
    expect(playerMoveSubmit).not.toHaveBeenCalled();

    fireEvent.pointerDown(otherToken, { pointerId: 3, button: 0, clientX: 300, clientY: 720 });
    fireEvent.pointerMove(canvas, { pointerId: 3, clientX: 800, clientY: 450 });
    fireEvent.pointerUp(canvas, { pointerId: 3, clientX: 800, clientY: 450 });
    fireEvent.keyDown(otherToken, { key: "ArrowRight" });
    expect(playerMoveSubmit).not.toHaveBeenCalled();

    fireEvent.pointerDown(ownToken, { pointerId: 7, button: 0, clientX: 120, clientY: 770 });
    fireEvent.pointerMove(canvas, { pointerId: 7, clientX: 800, clientY: 450 });
    fireEvent.pointerUp(canvas, { pointerId: 7, clientX: 800, clientY: 450 });

    await waitFor(() => expect(playerMoveSubmit).toHaveBeenCalledTimes(1));
    const movement = proposalAt(playerMoveSubmit, 0, "board.item.upserted");
    expect(movement.payload.item).toMatchObject({
      label: miniInvestigator.name,
      position: { x: 800, y: 450 },
    });
    authority.commit(miniPlayerSeat, movement);
    cleanup();

    board = requireBoard(authority.playerWorld, boardId);
    const entries = detectSceneEntriesV2(authority.playerWorld, board);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.scene.name).toBe("后台唱片室");
    expect(entries[0]?.characters.map(({ entity }) => entity.name)).toEqual([miniInvestigator.name]);

    // 5. Movement informs the KP, but never auto-publishes module prose. The
    // KP explicitly writes the public framing, then releases one related
    // location and one NPC through the workbench.
    const presentationSubmit = vi.fn().mockResolvedValue("confirmed");
    render(
      <KeeperModuleWorkbenchV2
        modulePackage={mapModule}
        world={authority.world}
        board={requireBoard(authority.world, boardId)}
        session={mockSession(authority.world, miniHostSeat, presentationSubmit)}
      />,
    );
    expect(screen.getByRole("status", { name: "调查员进入了另一个场景" }).textContent).toContain(miniInvestigator.name);
    fireEvent.change(screen.getByLabelText("玩家可见的开场描述"), {
      target: { value: mapInvestigation.publicOpening },
    });
    fireEvent.click(screen.getByRole("button", { name: "向所有人呈现这个场景" }));
    await waitFor(() => expect(presentationSubmit).toHaveBeenCalledTimes(2));
    expect(serializedCalls(presentationSubmit)).not.toContain(miniInvestigation.secrets.sceneSynopsis);
    expect(serializedCalls(presentationSubmit)).not.toContain(miniInvestigation.secrets.keeperNotes);
    authority.commitCalls(miniHostSeat, presentationSubmit);
    cleanup();

    const locationSubmit = vi.fn().mockResolvedValue("confirmed");
    render(
      <KeeperModuleWorkbenchV2
        modulePackage={mapModule}
        world={authority.world}
        board={requireBoard(authority.world, boardId)}
        session={mockSession(authority.world, miniHostSeat, locationSubmit)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "让地点在当前情境登场" }));
    await waitFor(() => expect(locationSubmit).toHaveBeenCalledTimes(2));
    expect(serializedCalls(locationSubmit)).toContain(mapInvestigation.publicLocation);
    expect(serializedCalls(locationSubmit)).not.toContain(mapInvestigation.secrets.location);
    authority.commitCalls(miniHostSeat, locationSubmit);
    cleanup();

    const npcSubmit = vi.fn().mockResolvedValue("confirmed");
    render(
      <KeeperModuleWorkbenchV2
        modulePackage={mapModule}
        world={authority.world}
        board={requireBoard(authority.world, boardId)}
        session={mockSession(authority.world, miniHostSeat, npcSubmit)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "让 NPC 在当前情境登场" }));
    await waitFor(() => expect(npcSubmit).toHaveBeenCalledTimes(2));
    expect(serializedCalls(npcSubmit)).toContain(mapInvestigation.publicNpc);
    expect(serializedCalls(npcSubmit)).not.toContain(mapInvestigation.secrets.npc);
    expect(serializedCalls(npcSubmit)).not.toContain("board.item.upserted");
    authority.commitCalls(miniHostSeat, npcSubmit);
    cleanup();

    const npcPlacementSubmit = vi.fn().mockResolvedValue("confirmed");
    render(
      <KeeperModuleWorkbenchV2
        modulePackage={mapModule}
        world={authority.world}
        board={requireBoard(authority.world, boardId)}
        session={mockSession(authority.world, miniHostSeat, npcPlacementSubmit)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "放一个 NPC 棋子到当前画面" }));
    await waitFor(() => expect(npcPlacementSubmit).toHaveBeenCalledTimes(1));
    authority.commitCalls(miniHostSeat, npcPlacementSubmit);
    cleanup();

    // 6. A fresh player mount derives everything from its own projected event
    // views. Public framing, location and NPC remain visible across remounts;
    // no KP-only module field ever entered that replica or the rendered DOM.
    const finalPlayerSubmit = vi.fn().mockResolvedValue("submitted");
    const renderFinalPlayerRoom = () => renderRoom(
      authority.playerWorld,
      miniPlayerSeat,
      finalPlayerSubmit,
      authority.playerViews,
    );
    const firstMount = renderFinalPlayerRoom();
    assertPlayerSituation();
    firstMount.unmount();
    renderFinalPlayerRoom();
    assertPlayerSituation();

    fireEvent.click(screen.getByRole("button", { name: "展开画面：新的调查地图" }));
    const finalNpcToken = screen.getByRole("button", { name: "藤原真一（只能查看）" });
    fireEvent.keyDown(finalNpcToken, { key: "ArrowRight" });
    expect(finalPlayerSubmit).not.toHaveBeenCalled();

    const projected = JSON.stringify(authority.playerViews);
    expect(projected).not.toContain(miniInvestigation.secrets.sceneSynopsis);
    expect(projected).not.toContain(miniInvestigation.secrets.keeperNotes);
    expect(projected).not.toContain(mapInvestigation.secrets.location);
    expect(projected).not.toContain(mapInvestigation.secrets.npc);
  }, 20_000);
});

class MapJourneyAuthority {
  private readonly sequencer = new HostEventSequencerV2(miniInvestigation.roomId);
  private readonly playerReplica = new EventViewReplicaV2(miniInvestigation.roomId);

  get world(): RoomWorldStateV2 {
    return this.sequencer.world;
  }

  get playerWorld(): RoomWorldStateV2 {
    return this.playerReplica.deriveWorld();
  }

  get playerViews() {
    return this.playerReplica.orderedViews();
  }

  commit(sender: SeatV2, proposal: RoomEventProposalV2): void {
    this.sequencer.commitCommand(
      createRoomCommandV2(miniInvestigation.roomId, sender, proposal),
      sender,
    );
    for (const view of this.sequencer.viewsAfter(
      miniPlayerSeat,
      this.playerReplica.lastContiguousSequence,
    )) {
      this.playerReplica.apply(view);
    }
  }

  commitCalls(sender: SeatV2, submit: ReturnType<typeof vi.fn>): void {
    for (const [proposal] of submit.mock.calls) {
      this.commit(sender, proposal as RoomEventProposalV2);
    }
  }
}

function mockSession(
  world: RoomWorldStateV2,
  localSeat: SeatV2,
  submit: ReturnType<typeof vi.fn>,
): RoomSessionV2 {
  return {
    world,
    localSeat,
    isHost: localSeat.role === "host",
    isAuthenticated: true,
    submit,
    submitConfirmed: submit,
    sendPreview: vi.fn(),
  } as unknown as RoomSessionV2;
}

function renderRoom(
  world: RoomWorldStateV2,
  localSeat: SeatV2,
  submit: ReturnType<typeof vi.fn>,
  views: ReturnType<EventViewReplicaV2["orderedViews"]> = [],
) {
  return render(
    <RoomViewV2
      room={miniRoomRecord(localSeat.role)}
      session={mockSession(world, localSeat, submit)}
      views={views}
      world={world}
      seats={[miniHostSeat, miniPlayerSeat, otherPlayerSeat]}
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

function requireBoard(world: RoomWorldStateV2, boardId: string) {
  const board = world.boards.get(boardId);
  expect(board).toBeDefined();
  return board!;
}

function entityBoardItem(
  itemId: string,
  entity: RoomEntityV2,
  position: { x: number; y: number },
  size: { width: number; height: number },
): BoardItemV1 {
  return {
    schemaVersion: 1,
    itemId,
    reference: { kind: "entity", entityId: entity.entityId },
    label: entity.name,
    position,
    size,
    rotationDegrees: 0,
    scale: 1,
    zIndex: 10,
    locked: false,
    audience: roomAudience,
    extensions: { roomRole: "character-token" },
  };
}

function serializedCalls(mock: ReturnType<typeof vi.fn>): string {
  return JSON.stringify(mock.mock.calls);
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

function assertPlayerSituation(): void {
  const currentSituation = screen.getByLabelText("当前情境");
  expect(within(currentSituation).getByRole("heading", { level: 2, name: "后台唱片室" })).toBeTruthy();
  expect(within(currentSituation).getByText(mapInvestigation.publicOpening)).toBeTruthy();
  const locations = within(currentSituation).getByLabelText("当前情境中的地点");
  expect(within(locations).getByText("后台唱片室")).toBeTruthy();
  expect(within(locations).getByText(mapInvestigation.publicLocation)).toBeTruthy();
  const npcs = within(currentSituation).getByLabelText("当前情境中的人物");
  expect(within(npcs).getByText("藤原真一")).toBeTruthy();
  expect(within(npcs).getByText(mapInvestigation.publicNpc)).toBeTruthy();
  expect(document.body.textContent).not.toContain(miniInvestigation.secrets.sceneSynopsis);
  expect(document.body.textContent).not.toContain(miniInvestigation.secrets.keeperNotes);
  expect(document.body.textContent).not.toContain(mapInvestigation.secrets.location);
  expect(document.body.textContent).not.toContain(mapInvestigation.secrets.npc);
}
