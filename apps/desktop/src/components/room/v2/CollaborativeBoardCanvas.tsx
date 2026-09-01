import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  BoardEdgeV1,
  BoardItemV1,
  BoardPointV1,
  BoardV1,
  FogMaskV1,
  RoomArtifactV2,
} from "@coc-room/protocol";

import { cn } from "../../../lib/cn";
import { BOARD_EXTERNAL_DROP_MIME } from "./board-constants";

export type BoardInteractionMode = "move" | "connect" | "fog";
export { BOARD_EXTERNAL_DROP_MIME } from "./board-constants";

export interface CollaborativeBoardCanvasProps {
  readonly board: BoardV1;
  /** Artifacts from the caller's already-projected room view; never a module-library lookup. */
  readonly artifacts?: ReadonlyMap<string, RoomArtifactV2>;
  /** A locally resolved object URL. Asset descriptors never become remote URLs here. */
  readonly backgroundUrl?: string;
  /** Keeps a missing file distinct from a background that is still transferring or failed. */
  readonly backgroundState?: "loading" | "error";
  readonly readOnly?: boolean;
  readonly isKeeper?: boolean;
  readonly className?: string;
  readonly initialMode?: BoardInteractionMode;
  /** Allows the room shell to enforce role and ownership rules per item. */
  readonly canMoveItem?: (item: BoardItemV1) => boolean;
  readonly onSelectItem?: (item: BoardItemV1) => void;
  /** Transient drag information. Callers should send this over the ephemeral channel only. */
  readonly onPreview?: (item: BoardItemV1) => void;
  /** Called once when a completed drag (or keyboard move) changes an item. */
  readonly onCommitItem?: (item: BoardItemV1) => void | Promise<void>;
  /** Called after the user selects two distinct endpoints in connect mode. */
  readonly onCompleteEdge?: (fromItemId: string, toItemId: string) => void;
  /** Keeper-only callback for one completed revealed fog polygon. */
  readonly onCompleteFogRegion?: (points: readonly BoardPointV1[]) => void;
  /** Accepts a narrow app-owned payload from a room workbench, never files or URLs. */
  readonly onExternalDrop?: (payload: string, point: BoardPointV1) => void;
  readonly onSelectEdge?: (edge: BoardEdgeV1) => void;
}

interface ActiveDrag {
  readonly pointerId: number;
  readonly item: BoardItemV1;
  readonly startPointer: BoardPointV1;
  currentItem: BoardItemV1;
}

interface ActiveFogStroke {
  readonly pointerId: number;
  points: BoardPointV1[];
}

export function CollaborativeBoardCanvas({
  board,
  artifacts,
  backgroundUrl,
  backgroundState,
  readOnly = false,
  isKeeper = false,
  className,
  initialMode = "move",
  canMoveItem,
  onSelectItem,
  onPreview,
  onCommitItem,
  onCompleteEdge,
  onCompleteFogRegion,
  onExternalDrop,
  onSelectEdge,
}: CollaborativeBoardCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const activeDragRef = useRef<ActiveDrag>();
  const activeFogRef = useRef<ActiveFogStroke>();
  const [previewItem, setPreviewItem] = useState<BoardItemV1>();
  const [pendingItem, setPendingItem] = useState<{ item: BoardItemV1; acknowledged: boolean }>();
  const [commitNotice, setCommitNotice] = useState<string>();
  const [fogPreview, setFogPreview] = useState<readonly BoardPointV1[]>([]);
  const [mode, setMode] = useState<BoardInteractionMode>(initialMode);
  const [viewportScale, setViewportScale] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setFullscreen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [fullscreen]);
  const [edgeStartItemId, setEdgeStartItemId] = useState<string>();
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const maskId = `board-fog-${useId().replace(/:/g, "")}`;
  const itemById = useMemo(
    () => new Map(board.items.map((item) => [item.itemId, item] as const)),
    [board.items],
  );
  const canConnect = !readOnly && onCompleteEdge !== undefined;
  const canDrawFog = !readOnly && isKeeper && onCompleteFogRegion !== undefined;

  useEffect(() => {
    setPreviewItem(undefined);
    setPendingItem(undefined);
    setCommitNotice(undefined);
    activeDragRef.current = undefined;
    setFogPreview([]);
    activeFogRef.current = undefined;
    setEdgeStartItemId(undefined);
    setSelectedItemId(undefined);
    setViewportScale(1);
  }, [board.boardId]);

  useEffect(() => {
    if ((mode === "connect" && !canConnect) || (mode === "fog" && !canDrawFog)) {
      setMode("move");
    }
  }, [canConnect, canDrawFog, mode]);

  const renderedItem = (item: BoardItemV1): BoardItemV1 =>
    previewItem?.itemId === item.itemId
      ? previewItem
      : pendingItem?.item.itemId === item.itemId
        ? pendingItem.item
        : item;
  const selectedItem = selectedItemId ? itemById.get(selectedItemId) : undefined;
  const selectedArtifact = selectedItem?.reference.kind === "artifact"
    ? artifacts?.get(selectedItem.reference.artifactId)
    : undefined;

  useEffect(() => {
    if (selectedItemId && !itemById.has(selectedItemId)) setSelectedItemId(undefined);
  }, [itemById, selectedItemId]);

  useEffect(() => {
    if (!pendingItem) return;
    const authoritative = itemById.get(pendingItem.item.itemId);
    if (authoritative && samePoint(authoritative.position, pendingItem.item.position)) {
      setPendingItem(undefined);
      setCommitNotice(`“${pendingItem.item.label || referenceLabel(pendingItem.item)}”的位置已同步。`);
    }
  }, [itemById, pendingItem]);

  useEffect(() => {
    if (!pendingItem?.acknowledged) return;
    const timer = globalThis.setTimeout(() => {
      setPendingItem(undefined);
      setCommitNotice("位置长时间没有进入房间记录，已恢复为房主确认的状态。请检查连接后再试。");
    }, 8_000);
    return () => globalThis.clearTimeout(timer);
  }, [pendingItem]);

  useEffect(() => {
    if (!commitNotice) return;
    const timer = globalThis.setTimeout(() => setCommitNotice(undefined), 4_000);
    return () => globalThis.clearTimeout(timer);
  }, [commitNotice]);

  const commitItem = (item: BoardItemV1) => {
    if (!onCommitItem || pendingItem) return;
    setCommitNotice(undefined);
    setPendingItem({ item, acknowledged: false });
    try {
      void Promise.resolve(onCommitItem(item)).then(
        () => setPendingItem((current) => current?.item.itemId === item.itemId
          ? { item, acknowledged: true }
          : current),
        () => {
          setPendingItem((current) => current?.item.itemId === item.itemId ? undefined : current);
          setCommitNotice("房主没有接受这次移动，已恢复为房间记录中的位置。");
        },
      );
    } catch {
      setPendingItem(undefined);
      setCommitNotice("这次移动没有发出，已恢复为房间记录中的位置。");
    }
  };

  const pointFromPointer = (event: { readonly clientX: number; readonly clientY: number }) => {
    const bounds = svgRef.current?.getBoundingClientRect();
    const renderedWidth = bounds?.width || board.logicalSize.width;
    const renderedHeight = bounds?.height || board.logicalSize.height;
    return clampPoint(
      {
        x: Math.round(((event.clientX - (bounds?.left ?? 0)) / renderedWidth) * board.logicalSize.width),
        y: Math.round(((event.clientY - (bounds?.top ?? 0)) / renderedHeight) * board.logicalSize.height),
      },
      board,
    );
  };

  const selectEdgeEndpoint = (itemId: string) => {
    if (!canConnect) return;
    if (edgeStartItemId === undefined) {
      setEdgeStartItemId(itemId);
      return;
    }
    if (edgeStartItemId !== itemId) onCompleteEdge(edgeStartItemId, itemId);
    setEdgeStartItemId(undefined);
  };

  const selectItem = (item: BoardItemV1) => {
    setSelectedItemId(item.itemId);
    onSelectItem?.(item);
  };

  const beginItemPointer = (event: ReactPointerEvent<SVGGElement>, item: BoardItemV1) => {
    event.stopPropagation();
    selectItem(item);
    if (readOnly) return;
    if (mode === "connect") {
      selectEdgeEndpoint(item.itemId);
      return;
    }
    if (mode !== "move" || pendingItem || item.locked || canMoveItem?.(item) === false || onCommitItem === undefined) return;

    const startPointer = pointFromPointer(event);
    activeDragRef.current = {
      pointerId: event.pointerId,
      item,
      startPointer,
      currentItem: item,
    };
    setPreviewItem(item);
    safelyCapturePointer(svgRef.current, event.pointerId);
    event.preventDefault();
  };

  const movePointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    const activeDrag = activeDragRef.current;
    if (activeDrag !== undefined && activeDrag.pointerId === event.pointerId) {
      const pointer = pointFromPointer(event);
      const position = clampPoint(
        {
          x: activeDrag.item.position.x + pointer.x - activeDrag.startPointer.x,
          y: activeDrag.item.position.y + pointer.y - activeDrag.startPointer.y,
        },
        board,
      );
      const nextItem = { ...activeDrag.item, position };
      activeDrag.currentItem = nextItem;
      setPreviewItem(nextItem);
      onPreview?.(nextItem);
      return;
    }

    const activeFog = activeFogRef.current;
    if (activeFog !== undefined && activeFog.pointerId === event.pointerId) {
      const point = pointFromPointer(event);
      const previous = activeFog.points.at(-1);
      if (previous === undefined || pointDistance(previous, point) >= fogSamplingDistance(board)) {
        activeFog.points = [...activeFog.points, point];
        setFogPreview(activeFog.points);
      }
    }
  };

  const finishPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    const activeDrag = activeDragRef.current;
    if (activeDrag !== undefined && activeDrag.pointerId === event.pointerId) {
      const changed = !samePoint(activeDrag.item.position, activeDrag.currentItem.position);
      if (changed) commitItem(activeDrag.currentItem);
      activeDragRef.current = undefined;
      setPreviewItem(undefined);
      safelyReleasePointer(svgRef.current, event.pointerId);
      return;
    }

    const activeFog = activeFogRef.current;
    if (activeFog !== undefined && activeFog.pointerId === event.pointerId) {
      const finalPoint = pointFromPointer(event);
      const points = appendDistinctPoint(activeFog.points, finalPoint);
      if (points.length >= 3) onCompleteFogRegion?.(points);
      activeFogRef.current = undefined;
      setFogPreview([]);
      safelyReleasePointer(svgRef.current, event.pointerId);
    }
  };

  const cancelPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (activeDragRef.current?.pointerId === event.pointerId) {
      activeDragRef.current = undefined;
      setPreviewItem(undefined);
    }
    if (activeFogRef.current?.pointerId === event.pointerId) {
      activeFogRef.current = undefined;
      setFogPreview([]);
    }
    safelyReleasePointer(svgRef.current, event.pointerId);
  };

  const beginCanvasPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (mode !== "fog" || !canDrawFog || event.button !== 0) return;
    const point = pointFromPointer(event);
    activeFogRef.current = { pointerId: event.pointerId, points: [point] };
    setFogPreview([point]);
    safelyCapturePointer(svgRef.current, event.pointerId);
    event.preventDefault();
  };

  const handleItemKey = (event: ReactKeyboardEvent<SVGGElement>, item: BoardItemV1) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectItem(item);
      if (mode === "connect" && canConnect) selectEdgeEndpoint(item.itemId);
      return;
    }
    if (readOnly || pendingItem || item.locked || canMoveItem?.(item) === false || mode !== "move" || onCommitItem === undefined) return;
    const delta = event.shiftKey ? 100 : 20;
    const offsets: Partial<Record<string, BoardPointV1>> = {
      ArrowLeft: { x: -delta, y: 0 },
      ArrowRight: { x: delta, y: 0 },
      ArrowUp: { x: 0, y: -delta },
      ArrowDown: { x: 0, y: delta },
    };
    const offset = offsets[event.key];
    if (offset === undefined) return;
    event.preventDefault();
    const nextItem = {
      ...item,
      position: clampPoint(
        { x: item.position.x + offset.x, y: item.position.y + offset.y },
        board,
      ),
    };
    if (!samePoint(item.position, nextItem.position)) commitItem(nextItem);
  };

  const chooseMode = (nextMode: BoardInteractionMode) => {
    setMode(nextMode);
    setEdgeStartItemId(undefined);
    setFogPreview([]);
    activeFogRef.current = undefined;
  };

  const moveSelectedItem = (offset: BoardPointV1) => {
    if (pendingItem || !selectedItem || !canMove(selectedItem, readOnly, canMoveItem, onCommitItem)) return;
    const nextItem = {
      ...selectedItem,
      position: clampPoint({
        x: selectedItem.position.x + offset.x,
        y: selectedItem.position.y + offset.y,
      }, board),
    };
    if (!samePoint(selectedItem.position, nextItem.position)) commitItem(nextItem);
  };

  const acceptExternalDrag = (event: ReactDragEvent<HTMLDivElement>) => {
    if (readOnly || onExternalDrop === undefined || !event.dataTransfer.types.includes(BOARD_EXTERNAL_DROP_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const dropExternalItem = (event: ReactDragEvent<HTMLDivElement>) => {
    if (readOnly || onExternalDrop === undefined) return;
    const payload = event.dataTransfer.getData(BOARD_EXTERNAL_DROP_MIME);
    if (!payload) return;
    event.preventDefault();
    onExternalDrop(payload, pointFromPointer(event));
  };

  return (
    <section
      aria-label={`协作画面：${board.name}`}
      className={cn(
        "grid gap-2",
        fullscreen && "fixed inset-0 z-50 content-start overflow-auto bg-zinc-950/95 p-4 backdrop-blur",
        className,
      )}
    >
      <header className="flex flex-col justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/65 px-3 py-2.5 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[.18em] text-brass">
            当前{boardKindLabel(board.kind)}
          </p>
          <h3 className="mt-0.5 truncate text-sm font-semibold text-zinc-100">{board.name}</h3>
          {board.description && <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500">{board.description}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-md border border-zinc-800 bg-zinc-950 p-1">
          <button type="button" aria-label="缩小画面" disabled={viewportScale <= 1} onClick={() => setViewportScale((value) => Math.max(1, value - 0.25))} className="grid h-9 w-9 place-items-center rounded text-base text-zinc-400 hover:bg-zinc-800 disabled:text-zinc-700">−</button>
          <button type="button" aria-label="让画面适合窗口" onClick={() => setViewportScale(1)} className="min-w-14 rounded px-2 py-2 text-xs text-zinc-400 hover:bg-zinc-800">{Math.round(viewportScale * 100)}%</button>
          <button type="button" aria-label="放大画面" disabled={viewportScale >= 3} onClick={() => setViewportScale((value) => Math.min(3, value + 0.25))} className="grid h-9 w-9 place-items-center rounded text-base text-zinc-400 hover:bg-zinc-800 disabled:text-zinc-700">＋</button>
          <button type="button" aria-label={fullscreen ? "退出全屏画面" : "全屏画面"} aria-pressed={fullscreen} onClick={() => setFullscreen((value) => !value)} className="rounded px-2.5 py-2 text-xs text-zinc-400 hover:bg-zinc-800">{fullscreen ? "退出全屏" : "全屏"}</button>
        </div>
      </header>

      <div role="toolbar" aria-label="画面操作" className="flex flex-wrap items-center gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <ModeButton active={mode === "move"} onClick={() => chooseMode("move")}>摆放内容</ModeButton>
          {canConnect && (
            <ModeButton active={mode === "connect"} onClick={() => chooseMode("connect")}>
              {edgeStartItemId === undefined ? "画关系线" : "再选一项完成连线"}
            </ModeButton>
          )}
          {canDrawFog && (
            <ModeButton active={mode === "fog"} onClick={() => chooseMode("fog")}>揭开迷雾</ModeButton>
          )}
        </div>
      </div>
      <p role="status" className="rounded-md bg-zinc-900/70 px-3 py-2 text-xs leading-5 text-zinc-400">
        {commitNotice ?? (pendingItem
          ? pendingItem.acknowledged
            ? `房主已收到“${pendingItem.item.label || referenceLabel(pendingItem.item)}”的新位置，正在同步给所有人…`
            : `正在保存“${pendingItem.item.label || referenceLabel(pendingItem.item)}”的新位置…`
          : interactionHelp(mode, readOnly, board.fogMask !== undefined, edgeStartItemId ? itemById.get(edgeStartItemId) : undefined))}
      </p>

      <div className={cn(
        "overflow-auto rounded-xl border border-white/10 bg-zinc-950 shadow-2xl shadow-black/30",
        fullscreen ? "h-[calc(100vh-15rem)]" : "h-[clamp(16rem,46vh,38rem)]",
      )}>
        <div
          className="relative isolate mx-auto min-h-52 overflow-hidden"
          style={{
            aspectRatio: `${board.logicalSize.width} / ${board.logicalSize.height}`,
            height: `${viewportScale * 100}%`,
          }}
          onDragOver={acceptExternalDrag}
          onDrop={dropExternalItem}
        >
          {backgroundUrl ? (
            <img
              src={backgroundUrl}
              alt={`画面背景：${board.name}`}
              draggable={false}
              className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
            />
          ) : (
            <div
              data-testid="board-fallback-background"
              aria-hidden="true"
              className="absolute inset-0"
              style={fallbackBackground(board.kind)}
            />
          )}
          {backgroundState && !backgroundUrl && (
            <div
              aria-label="画面背景状态"
              className={`pointer-events-none absolute left-3 top-3 z-30 max-w-[min(28rem,calc(100%-1.5rem))] rounded-lg border px-3 py-2 text-xs leading-5 shadow-lg backdrop-blur-sm ${backgroundState === "loading" ? "border-sky-800/70 bg-sky-950/85 text-sky-200" : "border-amber-800/70 bg-amber-950/90 text-amber-100"}`}
            >
              {backgroundState === "loading"
                ? "背景正在从本机或房主处载入；你仍可查看和操作画面。"
                : "背景未能载入，已暂用默认画面。请让 KP 检查资源或房间连接。"}
            </div>
          )}
          {board.items.length === 0 && (
            <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center px-6 text-center">
              <div className="max-w-sm rounded-xl border border-dashed border-zinc-700 bg-zinc-950/85 px-5 py-4 shadow-xl backdrop-blur-sm">
                <p className="text-sm font-medium text-zinc-200">画面里还没有内容</p>
                <p className="mt-1 text-xs leading-5 text-zinc-500">
                  {readOnly
                    ? "这份记录里没有摆放人物、地点或线索。"
                    : isKeeper
                      ? "从 KP 工具中选择地点、人物或线索，再放到这里。"
                      : "KP 还没有在这里放置人物、地点或线索。"}
                </p>
              </div>
            </div>
          )}
          <svg
            ref={svgRef}
            role="group"
            aria-label={`${board.name} 画面内容`}
            className={cn(
              "absolute inset-0 h-full w-full touch-none select-none",
              mode === "fog" && canDrawFog && "cursor-crosshair",
            )}
            viewBox={`0 0 ${board.logicalSize.width} ${board.logicalSize.height}`}
            preserveAspectRatio="none"
            onPointerDown={beginCanvasPointer}
            onPointerMove={movePointer}
            onPointerUp={finishPointer}
            onPointerCancel={cancelPointer}
          >
            <title>{board.name}</title>
            <g aria-label="关系线">
              {board.edges.map((edge) => {
                const from = itemById.get(edge.fromItemId);
                const to = itemById.get(edge.toItemId);
                if (from === undefined || to === undefined) return null;
                const renderedFrom = renderedItem(from);
                const renderedTo = renderedItem(to);
                const middleX = (renderedFrom.position.x + renderedTo.position.x) / 2;
                const middleY = (renderedFrom.position.y + renderedTo.position.y) / 2;
                return (
                  <g
                    key={edge.edgeId}
                    data-testid={`board-edge-${edge.edgeId}`}
                    role={onSelectEdge ? "button" : "img"}
                    tabIndex={0}
                    aria-label={edgeAccessibleLabel(edge, from, to)}
                    onClick={() => onSelectEdge?.(edge)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      onSelectEdge?.(edge);
                    }}
                    className={cn(
                      "outline-none focus-visible:[&>line]:stroke-amber-300",
                      onSelectEdge && "cursor-pointer",
                    )}
                  >
                    <line
                      x1={renderedFrom.position.x}
                      y1={renderedFrom.position.y}
                      x2={renderedTo.position.x}
                      y2={renderedTo.position.y}
                      stroke="rgba(251, 191, 36, .72)"
                      strokeWidth={Math.max(3, board.logicalSize.width / 500)}
                      vectorEffect="non-scaling-stroke"
                    />
                    {edge.label && (
                      <text
                        x={middleX}
                        y={middleY}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill="#fde68a"
                        stroke="#09090b"
                        strokeWidth={Math.max(2, board.logicalSize.width / 1_000)}
                        paintOrder="stroke"
                        fontSize={Math.max(28, board.logicalSize.width / 48)}
                        pointerEvents="none"
                      >
                        {edge.label}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>

            <g aria-label="画面中的内容">
              {[...board.items]
                .sort((left, right) => left.zIndex - right.zIndex)
                .map((originalItem) => {
                  const item = renderedItem(originalItem);
                  const size = item.size ?? defaultItemSize(board);
                  const activeEdgeEndpoint = edgeStartItemId === item.itemId;
                  const moveAllowed = canMoveItem?.(originalItem) !== false;
                  const editable = !pendingItem && !readOnly && !item.locked && moveAllowed && mode === "move" && onCommitItem !== undefined;
                  return (
                    <g
                      key={item.itemId}
                      data-testid={`board-item-${item.itemId}`}
                      role="button"
                      tabIndex={0}
                      aria-label={`${item.label || referenceLabel(item)}${item.locked ? "（位置已锁定）" : !moveAllowed || readOnly ? "（只能查看）" : ""}`}
                      aria-pressed={selectedItemId === item.itemId}
                      transform={`translate(${item.position.x} ${item.position.y}) rotate(${item.rotationDegrees}) scale(${item.scale})`}
                      onPointerDown={(event) => beginItemPointer(event, originalItem)}
                      onKeyDown={(event) => handleItemKey(event, originalItem)}
                      onClick={() => selectItem(originalItem)}
                      className={cn(
                        "outline-none focus-visible:[&>rect]:stroke-amber-300",
                        editable ? "cursor-grab active:cursor-grabbing" : "cursor-default",
                      )}
                    >
                      <rect
                        x={-size.width / 2}
                        y={-size.height / 2}
                        width={size.width}
                        height={size.height}
                        rx={Math.min(size.width, size.height) * 0.12}
                        fill={activeEdgeEndpoint ? "rgba(120, 53, 15, .94)" : "rgba(24, 24, 27, .92)"}
                        stroke={item.locked ? "rgba(113, 113, 122, .75)" : "rgba(251, 191, 36, .9)"}
                        strokeWidth={Math.max(3, board.logicalSize.width / 650)}
                        vectorEffect="non-scaling-stroke"
                      />
                      <text
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill={item.locked ? "#a1a1aa" : "#f4f4f5"}
                        fontSize={Math.max(30, Math.min(size.height * 0.28, size.width / 9))}
                        pointerEvents="none"
                      >
                        {truncateLabel(item.label || referenceLabel(item), 28)}
                      </text>
                    </g>
                  );
                })}
            </g>

            {board.fogMask && <FogOverlay mask={board.fogMask} board={board} maskId={maskId} />}
            {fogPreview.length > 0 && (
              <polyline
                data-testid="fog-preview"
                points={pointsAttribute(fogPreview)}
                fill="rgba(16, 185, 129, .12)"
                stroke="#34d399"
                strokeWidth={Math.max(3, board.logicalSize.width / 500)}
                strokeDasharray="12 8"
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
            )}
          </svg>
        </div>
      </div>
      {board.items.length > 0 && (
        <section aria-label="当前选中的画面内容" className="rounded-lg border border-zinc-800 bg-zinc-950/55 p-3">
          {selectedItem ? (
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                {selectedArtifact ? (
                  <div aria-label="选中的公开资料" className="rounded-md border border-amber-900/35 bg-amber-950/15 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-[.16em] text-amber-500">公开线索</p>
                    <h4 className="mt-1 text-sm font-semibold text-zinc-100">{selectedArtifact.title}</h4>
                    {selectedArtifact.body && (
                      <p className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm leading-6 text-zinc-300">
                        {selectedArtifact.body}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="truncate text-sm font-medium text-zinc-100">{selectedItem.label || referenceLabel(selectedItem)}</p>
                )}
                <p className="mt-1 text-xs leading-5 text-zinc-500">
                  {pendingItem?.item.itemId === selectedItem.itemId
                    ? "新位置正在同步；确认完成前暂时不能再次移动。"
                    : selectedItem.locked
                    ? "位置已由 KP 锁定；仍可点开查看内容。"
                    : canMoveItem?.(selectedItem) === false
                      ? "你可以查看这项内容，但不能移动它。"
                      : readOnly || onCommitItem === undefined
                        ? "这张画面目前只能查看。"
                        : "可直接拖动，也可用方向按钮或键盘方向键移动。"}
                </p>
              </div>
              {!pendingItem && canMove(selectedItem, readOnly, canMoveItem, onCommitItem) && (
                <div aria-label={`移动 ${selectedItem.label || referenceLabel(selectedItem)}`} className="grid shrink-0 grid-cols-3 gap-1">
                  <span aria-hidden="true" />
                  <MoveButton label="向上移动" onClick={() => moveSelectedItem({ x: 0, y: -20 })}>↑</MoveButton>
                  <span aria-hidden="true" />
                  <MoveButton label="向左移动" onClick={() => moveSelectedItem({ x: -20, y: 0 })}>←</MoveButton>
                  <MoveButton label="向下移动" onClick={() => moveSelectedItem({ x: 0, y: 20 })}>↓</MoveButton>
                  <MoveButton label="向右移动" onClick={() => moveSelectedItem({ x: 20, y: 0 })}>→</MoveButton>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs leading-5 text-zinc-500">点一下人物、地点或线索即可查看；可以移动的内容会在选中后显示方向按钮。</p>
          )}
        </section>
      )}
    </section>
  );
}

function FogOverlay({ mask, board, maskId }: { mask: FogMaskV1; board: BoardV1; maskId: string }) {
  return (
    <g data-testid="board-fog" pointerEvents="none">
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={board.logicalSize.width} height={board.logicalSize.height}>
          <rect width={board.logicalSize.width} height={board.logicalSize.height} fill="white" />
          {mask.revealedRegions.map((region) => (
            <polygon key={region.regionId} points={pointsAttribute(region.points)} fill="black" />
          ))}
        </mask>
      </defs>
      <rect
        width={board.logicalSize.width}
        height={board.logicalSize.height}
        fill="rgba(0, 0, 0, .86)"
        mask={`url(#${maskId})`}
      />
    </g>
  );
}

function ModeButton({ active, onClick, children }: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-md border px-2.5 py-1.5 text-xs outline-none transition focus-visible:ring-2 focus-visible:ring-amber-400/80",
        active
          ? "border-amber-600/70 bg-amber-950/60 text-amber-200"
          : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-100",
      )}
    >
      {children}
    </button>
  );
}

function MoveButton({ label, onClick, children }: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="grid h-10 w-10 place-items-center rounded-md border border-zinc-700 bg-zinc-900 text-base text-zinc-200 outline-none hover:border-brass/60 hover:text-amber-200 focus-visible:ring-2 focus-visible:ring-brass/70"
    >
      {children}
    </button>
  );
}

function canMove(
  item: BoardItemV1,
  readOnly: boolean,
  canMoveItem: CollaborativeBoardCanvasProps["canMoveItem"],
  onCommitItem: CollaborativeBoardCanvasProps["onCommitItem"],
) {
  return !readOnly && !item.locked && canMoveItem?.(item) !== false && onCommitItem !== undefined;
}

function interactionHelp(
  mode: BoardInteractionMode,
  readOnly: boolean,
  hasFog: boolean,
  edgeStartItem?: BoardItemV1,
) {
  if (readOnly) {
    return hasFog
      ? "这张画面只能查看。黑色区域尚未被 KP 揭开。"
      : "这张画面只能查看；点一下人物、地点或线索可查看详情。";
  }
  if (mode === "connect") {
    return edgeStartItem
      ? `已选择“${edgeStartItem.label || referenceLabel(edgeStartItem)}”，再点另一项即可画出关系线。`
      : "依次点选两项内容即可画出关系线；关系线只用于整理人物与线索之间的联系。";
  }
  if (mode === "fog") {
    return "在黑色区域按住并拖动，松手后这片区域会向玩家揭开。已经发送的画面不能重新保密。";
  }
  return hasFog
    ? "拖动未锁定的内容调整位置。黑色区域是玩家尚未看见的部分。"
    : "拖动未锁定的内容调整位置；点选后也可以用方向按钮移动。";
}

function boardKindLabel(kind: BoardV1["kind"]) {
  switch (kind) {
    case "scene": return "场景画面";
    case "map": return "方位地图";
    case "evidence": return "线索关系板";
  }
}

function defaultItemSize(board: BoardV1) {
  return {
    width: Math.max(180, Math.round(board.logicalSize.width / 7)),
    height: Math.max(100, Math.round(board.logicalSize.height / 8)),
  };
}

function clampPoint(point: BoardPointV1, board: BoardV1): BoardPointV1 {
  return {
    x: Math.max(0, Math.min(board.logicalSize.width, Math.round(point.x))),
    y: Math.max(0, Math.min(board.logicalSize.height, Math.round(point.y))),
  };
}

function pointDistance(left: BoardPointV1, right: BoardPointV1) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function fogSamplingDistance(board: BoardV1) {
  return Math.max(4, Math.min(board.logicalSize.width, board.logicalSize.height) / 250);
}

function samePoint(left: BoardPointV1, right: BoardPointV1) {
  return left.x === right.x && left.y === right.y;
}

function appendDistinctPoint(points: readonly BoardPointV1[], point: BoardPointV1) {
  const previous = points.at(-1);
  return previous && samePoint(previous, point) ? [...points] : [...points, point];
}

function pointsAttribute(points: readonly BoardPointV1[]) {
  return points.map(({ x, y }) => `${x},${y}`).join(" ");
}

function referenceLabel(item: BoardItemV1) {
  switch (item.reference.kind) {
    case "entity": return "场景资料";
    case "artifact": return "资料";
    case "npc-session": return "NPC 互动";
    case "text": return item.reference.text || "文本";
  }
}

function edgeAccessibleLabel(edge: BoardEdgeV1, from: BoardItemV1, to: BoardItemV1) {
  const endpoints = `${from.label || referenceLabel(from)} → ${to.label || referenceLabel(to)}`;
  return edge.label ? `关系线：${endpoints}；${edge.label}` : `关系线：${endpoints}`;
}

function truncateLabel(label: string, maximum: number) {
  return label.length <= maximum ? label : `${label.slice(0, maximum - 1)}…`;
}

function fallbackBackground(kind: BoardV1["kind"]): CSSProperties {
  const accent = kind === "map"
    ? "rgba(30, 64, 175, .42)"
    : kind === "evidence"
      ? "rgba(120, 53, 15, .45)"
      : "rgba(88, 28, 135, .42)";
  return {
    backgroundColor: "#09090b",
    backgroundImage: [
      `radial-gradient(circle at 22% 18%, ${accent}, transparent 42%)`,
      "radial-gradient(circle at 78% 74%, rgba(39, 39, 42, .72), transparent 48%)",
      "linear-gradient(135deg, rgba(9, 9, 11, .72), rgba(0, 0, 0, .97))",
    ].join(", "),
  };
}

function safelyCapturePointer(element: SVGSVGElement | null, pointerId: number) {
  try {
    element?.setPointerCapture?.(pointerId);
  } catch {
    // A pointer can disappear between pointerdown and capture. Cancellation is harmless.
  }
}

function safelyReleasePointer(element: SVGSVGElement | null, pointerId: number) {
  try {
    if (element?.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
  } catch {
    // The browser may already have released capture after pointercancel.
  }
}
