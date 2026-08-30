// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardItemV1, BoardV1, RoomArtifactV2 } from "@coc-room/protocol";

import { CollaborativeBoardCanvas } from "./CollaborativeBoardCanvas";

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

describe("CollaborativeBoardCanvas", () => {
  it("keeps drag movement transient and commits exactly once on pointer-up", () => {
    const onPreview = vi.fn();
    const onCommitItem = vi.fn();
    render(
      <CollaborativeBoardCanvas
        board={createBoard()}
        onPreview={onPreview}
        onCommitItem={onCommitItem}
      />,
    );
    const canvas = screen.getByRole("group", { name: "失落剧场 画面内容" });
    mockCanvasBounds(canvas);
    const item = screen.getByTestId("board-item-npc-actor");

    fireEvent.pointerDown(item, { pointerId: 7, button: 0, clientX: 200, clientY: 150 });
    fireEvent.pointerMove(canvas, { pointerId: 7, clientX: 260, clientY: 190 });
    fireEvent.pointerMove(canvas, { pointerId: 7, clientX: 300, clientY: 200 });

    expect(onPreview).toHaveBeenCalledTimes(2);
    expect(onCommitItem).not.toHaveBeenCalled();
    expect(item.getAttribute("transform")).toContain("translate(300 200)");

    fireEvent.pointerUp(canvas, { pointerId: 7, clientX: 300, clientY: 200 });

    expect(onCommitItem).toHaveBeenCalledTimes(1);
    expect((onCommitItem.mock.calls[0]?.[0] as BoardItemV1).position).toEqual({ x: 300, y: 200 });
  });

  it("does not persist pointer movement before drag completion", () => {
    const onCommitItem = vi.fn();
    render(<CollaborativeBoardCanvas board={createBoard()} onCommitItem={onCommitItem} />);
    const canvas = screen.getByRole("group", { name: "失落剧场 画面内容" });
    mockCanvasBounds(canvas);

    fireEvent.pointerDown(screen.getByTestId("board-item-npc-actor"), {
      pointerId: 2,
      button: 0,
      clientX: 200,
      clientY: 150,
    });
    fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 410, clientY: 260 });

    expect(onCommitItem).not.toHaveBeenCalled();
  });

  it("keeps a moved token at its intended position until the authoritative board catches up", async () => {
    let finishCommit: (() => void) | undefined;
    const onCommitItem = vi.fn(() => new Promise<void>((resolve) => { finishCommit = resolve; }));
    const firstBoard = createBoard();
    const view = render(<CollaborativeBoardCanvas board={firstBoard} onCommitItem={onCommitItem} />);
    const canvas = screen.getByRole("group", { name: "失落剧场 画面内容" });
    mockCanvasBounds(canvas);
    const item = screen.getByTestId("board-item-npc-actor");

    fireEvent.pointerDown(item, { pointerId: 21, button: 0, clientX: 200, clientY: 150 });
    fireEvent.pointerMove(canvas, { pointerId: 21, clientX: 380, clientY: 260 });
    fireEvent.pointerUp(canvas, { pointerId: 21, clientX: 380, clientY: 260 });

    expect(item.getAttribute("transform")).toContain("translate(380 260)");
    expect(screen.getByRole("status").textContent).toContain("正在保存“沉默的演员”的新位置");
    expect(screen.queryByRole("button", { name: "向右移动" })).toBeNull();

    finishCommit?.();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("房主已收到"));
    expect(item.getAttribute("transform")).toContain("translate(380 260)");

    const updatedItem = { ...firstBoard.items[0]!, position: { x: 380, y: 260 } };
    view.rerender(<CollaborativeBoardCanvas board={{ ...firstBoard, revision: 2, items: [updatedItem, ...firstBoard.items.slice(1)] }} onCommitItem={onCommitItem} />);

    await waitFor(() => expect(screen.getByRole("status").textContent).not.toContain("正在同步给所有人"));
    expect(screen.getByTestId("board-item-npc-actor").getAttribute("transform")).toContain("translate(380 260)");
  });

  it("returns to the authoritative position when the host rejects a movement", async () => {
    const onCommitItem = vi.fn().mockRejectedValue(new Error("revision conflict"));
    render(<CollaborativeBoardCanvas board={createBoard()} onCommitItem={onCommitItem} />);
    const canvas = screen.getByRole("group", { name: "失落剧场 画面内容" });
    mockCanvasBounds(canvas);
    const item = screen.getByTestId("board-item-npc-actor");

    fireEvent.pointerDown(item, { pointerId: 22, button: 0, clientX: 200, clientY: 150 });
    fireEvent.pointerMove(canvas, { pointerId: 22, clientX: 430, clientY: 290 });
    fireEvent.pointerUp(canvas, { pointerId: 22, clientX: 430, clientY: 290 });

    expect(item.getAttribute("transform")).toContain("translate(430 290)");
    await waitFor(() => expect(item.getAttribute("transform")).toContain("translate(200 150)"));
    expect(screen.getByRole("status").textContent).toContain("房主没有接受这次移动");
    expect(onCommitItem).toHaveBeenCalledOnce();
  });

  it("keeps locked items immovable by pointer and keyboard", () => {
    const onPreview = vi.fn();
    const onCommitItem = vi.fn();
    render(
      <CollaborativeBoardCanvas
        board={createBoard()}
        onPreview={onPreview}
        onCommitItem={onCommitItem}
      />,
    );
    const canvas = screen.getByRole("group", { name: "失落剧场 画面内容" });
    mockCanvasBounds(canvas);
    const lockedItem = screen.getByTestId("board-item-clue-locked");

    fireEvent.pointerDown(lockedItem, { pointerId: 3, button: 0, clientX: 700, clientY: 350 });
    fireEvent.pointerMove(canvas, { pointerId: 3, clientX: 800, clientY: 420 });
    fireEvent.pointerUp(canvas, { pointerId: 3, clientX: 800, clientY: 420 });
    fireEvent.keyDown(lockedItem, { key: "ArrowRight" });

    expect(lockedItem.getAttribute("aria-label")).toContain("位置已锁定");
    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommitItem).not.toHaveBeenCalled();
    expect(lockedItem.getAttribute("transform")).toContain("translate(700 350)");
    expect(screen.getByText("位置已由 KP 锁定；仍可点开查看内容。")).toBeTruthy();
  });

  it("honors room ownership rules for otherwise unlocked items", () => {
    const onPreview = vi.fn();
    const onCommitItem = vi.fn();
    render(
      <CollaborativeBoardCanvas
        board={createBoard()}
        canMoveItem={(item) => item.itemId !== "npc-actor"}
        onPreview={onPreview}
        onCommitItem={onCommitItem}
      />,
    );
    const canvas = screen.getByRole("group", { name: "失落剧场 画面内容" });
    mockCanvasBounds(canvas);
    const npc = screen.getByTestId("board-item-npc-actor");

    fireEvent.pointerDown(npc, { pointerId: 9, button: 0, clientX: 200, clientY: 150 });
    fireEvent.pointerMove(canvas, { pointerId: 9, clientX: 360, clientY: 260 });
    fireEvent.pointerUp(canvas, { pointerId: 9, clientX: 360, clientY: 260 });
    fireEvent.keyDown(npc, { key: "ArrowRight" });

    expect(npc.getAttribute("aria-label")).toContain("只能查看");
    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommitItem).not.toHaveBeenCalled();
    expect(npc.getAttribute("transform")).toContain("translate(200 150)");
    expect(screen.getByText("你可以查看这项内容，但不能移动它。")).toBeTruthy();
  });

  it("renders the atmospheric fallback when no background URL is resolved", () => {
    render(<CollaborativeBoardCanvas board={createBoard()} />);

    const fallback = screen.getByTestId("board-fallback-background");
    expect(fallback.getAttribute("style")).toContain("gradient");
    expect(screen.queryByRole("img", { name: /画面背景/ })).toBeNull();
    expect(screen.getByTestId("board-edge-edge-suspicion")).toBeTruthy();
    expect(screen.getByText("互相怀疑")).toBeTruthy();
    expect(screen.getByTestId("board-fog")).toBeTruthy();
  });

  it("distinguishes a transferring background from a board that has no background", () => {
    render(<CollaborativeBoardCanvas board={createBoard()} backgroundState="loading" />);

    expect(screen.getByLabelText("画面背景状态").textContent).toContain("正在从本机或房主处载入");
    expect(screen.getByTestId("board-fallback-background")).toBeTruthy();
  });

  it("keeps play usable and explains when a referenced background cannot load", () => {
    render(<CollaborativeBoardCanvas board={createBoard()} backgroundState="error" />);

    expect(screen.getByLabelText("画面背景状态").textContent).toContain("未能载入");
    expect(screen.getByLabelText("画面背景状态").textContent).toContain("检查资源或房间连接");
    expect(screen.getByRole("group", { name: "失落剧场 画面内容" })).toBeTruthy();
  });

  it("exposes relation endpoints and labels to keyboard users", () => {
    const onSelectEdge = vi.fn();
    render(<CollaborativeBoardCanvas board={createBoard()} onSelectEdge={onSelectEdge} />);

    const edge = screen.getByRole("button", {
      name: "关系线：沉默的演员 → 锁定的票根；互相怀疑",
    });
    expect(edge.getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(edge, { key: "Enter" });
    fireEvent.keyDown(edge, { key: " " });
    fireEvent.click(edge);

    expect(onSelectEdge).toHaveBeenCalledTimes(3);
    expect(onSelectEdge).toHaveBeenNthCalledWith(1, expect.objectContaining({ edgeId: "edge-suspicion" }));
  });

  it("lets people enlarge a map and return it to a fitted view", () => {
    render(<CollaborativeBoardCanvas board={createBoard()} />);

    expect(screen.getByRole("button", { name: "让画面适合窗口" }).textContent).toBe("100%");
    fireEvent.click(screen.getByRole("button", { name: "放大画面" }));
    expect(screen.getByRole("button", { name: "让画面适合窗口" }).textContent).toBe("125%");
    fireEvent.click(screen.getByRole("button", { name: "让画面适合窗口" }));
    expect(screen.getByRole("button", { name: "让画面适合窗口" }).textContent).toBe("100%");
  });

  it("completes relation and keeper fog gestures only at their endpoints", () => {
    const onCompleteEdge = vi.fn();
    const onCompleteFogRegion = vi.fn();
    render(
      <CollaborativeBoardCanvas
        board={createBoard()}
        isKeeper
        onCompleteEdge={onCompleteEdge}
        onCompleteFogRegion={onCompleteFogRegion}
      />,
    );
    const canvas = screen.getByRole("group", { name: "失落剧场 画面内容" });
    mockCanvasBounds(canvas);

    fireEvent.click(screen.getByRole("button", { name: "画关系线" }));
    fireEvent.pointerDown(screen.getByTestId("board-item-npc-actor"), { pointerId: 11 });
    expect(onCompleteEdge).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("已选择“沉默的演员”");
    fireEvent.pointerDown(screen.getByTestId("board-item-clue-locked"), { pointerId: 12 });
    expect(onCompleteEdge).toHaveBeenCalledWith("npc-actor", "clue-locked");

    fireEvent.click(screen.getByRole("button", { name: "揭开迷雾" }));
    expect(screen.getByRole("status").textContent).toContain("松手后这片区域会向玩家揭开");
    fireEvent.pointerDown(canvas, { pointerId: 13, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(canvas, { pointerId: 13, clientX: 250, clientY: 100 });
    fireEvent.pointerMove(canvas, { pointerId: 13, clientX: 250, clientY: 220 });
    expect(onCompleteFogRegion).not.toHaveBeenCalled();
    fireEvent.pointerUp(canvas, { pointerId: 13, clientX: 100, clientY: 220 });

    expect(onCompleteFogRegion).toHaveBeenCalledTimes(1);
    expect(onCompleteFogRegion.mock.calls[0]?.[0]).toHaveLength(4);
  });

  it("offers touch-friendly direction buttons after selecting a movable item", () => {
    const onCommitItem = vi.fn();
    render(<CollaborativeBoardCanvas board={createBoard()} onCommitItem={onCommitItem} />);

    fireEvent.click(screen.getByRole("button", { name: "沉默的演员" }));
    expect(screen.getByText(/可直接拖动，也可用方向按钮/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "向右移动" }));

    expect(onCommitItem).toHaveBeenCalledOnce();
    expect((onCommitItem.mock.calls[0]?.[0] as BoardItemV1).position).toEqual({ x: 220, y: 150 });
  });

  it("shows the title and body of a selected artifact from the projected room view", () => {
    const projectedClue: RoomArtifactV2 = {
      schemaVersion: 2,
      artifactId: "artifact-ticket",
      revision: 1,
      kind: "clue",
      title: "烧焦的末班票根",
      description: "从剧场座位下找到的旧票根。",
      body: "背面写着：午夜后不要回应舞台上的掌声。\n右下角有一枚月形戳记。",
      attachments: [],
      audience: { kind: "room" },
      locked: false,
      archived: false,
      extensions: {},
    };
    render(
      <CollaborativeBoardCanvas
        board={createBoard()}
        artifacts={new Map([[projectedClue.artifactId, projectedClue]])}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "锁定的票根（位置已锁定）" }));

    expect(screen.getByRole("heading", { name: "烧焦的末班票根" })).toBeTruthy();
    expect(screen.getByText(/午夜后不要回应舞台上的掌声/)).toBeTruthy();
    expect(screen.getByText(/右下角有一枚月形戳记/)).toBeTruthy();
  });

  it("does not invent artifact details when they are absent from the projected room view", () => {
    render(<CollaborativeBoardCanvas board={createBoard()} artifacts={new Map()} />);

    fireEvent.click(screen.getByRole("button", { name: "锁定的票根（位置已锁定）" }));

    expect(within(screen.getByRole("region", { name: "当前选中的画面内容" })).getByText("锁定的票根")).toBeTruthy();
    expect(screen.queryByLabelText("选中的公开资料")).toBeNull();
    expect(screen.queryByText("烧焦的末班票根")).toBeNull();
  });

  it("explains an empty picture differently to the KP and players", () => {
    const emptyBoard = { ...createBoard(), items: [], edges: [], fogMask: undefined };
    const { rerender } = render(<CollaborativeBoardCanvas board={emptyBoard} isKeeper />);

    expect(screen.getByText("画面里还没有内容")).toBeTruthy();
    expect(screen.getByText(/从 KP 工具中选择地点、人物或线索/)).toBeTruthy();

    rerender(<CollaborativeBoardCanvas board={emptyBoard} />);
    expect(screen.getByText(/KP 还没有在这里放置/)).toBeTruthy();
  });
});

function createBoard(): BoardV1 {
  return {
    schemaVersion: 1,
    boardId: "board-theater",
    revision: 1,
    kind: "evidence",
    name: "失落剧场",
    description: "调查员整理剧场中的人物与线索。",
    audience: { kind: "room" },
    logicalSize: { width: 1_000, height: 500 },
    archived: false,
    items: [
      {
        schemaVersion: 1,
        itemId: "npc-actor",
        reference: { kind: "entity", entityId: "entity-actor" },
        label: "沉默的演员",
        position: { x: 200, y: 150 },
        size: { width: 180, height: 90 },
        rotationDegrees: 0,
        scale: 1,
        zIndex: 2,
        locked: false,
        audience: { kind: "room" },
        extensions: {},
      },
      {
        schemaVersion: 1,
        itemId: "clue-locked",
        reference: { kind: "artifact", artifactId: "artifact-ticket" },
        label: "锁定的票根",
        position: { x: 700, y: 350 },
        size: { width: 180, height: 90 },
        rotationDegrees: 0,
        scale: 1,
        zIndex: 1,
        locked: true,
        audience: { kind: "room" },
        extensions: {},
      },
    ],
    edges: [
      {
        schemaVersion: 1,
        edgeId: "edge-suspicion",
        fromItemId: "npc-actor",
        toItemId: "clue-locked",
        kind: "suspects",
        label: "互相怀疑",
        audience: { kind: "room" },
        extensions: {},
      },
    ],
    fogMask: {
      schemaVersion: 1,
      maskId: "fog-theater",
      revision: 1,
      mode: "cover-all",
      audience: { kind: "room" },
      revealedRegions: [
        {
          regionId: "reveal-stage",
          points: [{ x: 100, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 300 }],
        },
      ],
      extensions: {},
    },
    extensions: {},
  };
}

function mockCanvasBounds(element: HTMLElement) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1_000,
    bottom: 500,
    width: 1_000,
    height: 500,
    toJSON: () => ({}),
  });
}
