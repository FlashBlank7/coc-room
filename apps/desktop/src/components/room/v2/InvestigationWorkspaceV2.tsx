import { characteristicBandSuffix } from "../../../lib/characteristic-bands";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  isAudienceSubsetV2,
  type BoardItemV1,
  type BoardPointV1,
  type BoardV1,
  type CheckDifficulty,
  type CheckRequestV2,
  type Coc7Character,
  type ModuleClueV1,
  type ModuleLocationV1,
  type ModuleNpcV1,
  type ModulePackageV1,
  type ModuleSceneV1,
  type RoomArtifactV2,
  type RoomEntityV2,
  type RoomWorldStateV2,
} from "@coc-room/protocol";
import { BookOpen, Check, Dices, Eye, MapPin, PackagePlus, UserRound } from "lucide-react";

import { RoomCommandRejectedError, type RoomSessionV2 } from "../../../network/RoomSessionV2";
import { Button } from "../../ui/Button";
import { Field, Input, Textarea } from "../../ui/Field";
import { Panel } from "../../ui/Panel";
import { BOARD_EXTERNAL_DROP_MIME } from "./board-constants";
import {
  ArtifactAttachmentViewerV2,
  type ResolveRoomAssetV2,
} from "./ArtifactAttachmentViewerV2";
import {
  clampBoardPoint,
  detectSceneEntriesV2,
  ensureModuleEntityV2,
  findModuleEntityV2,
  pendingModuleSceneEntriesV2,
  placeEntityOnBoardV2,
  placeModuleSceneOnBoardV2,
  presentModuleSceneV2,
} from "./investigation-workspace-helpers";

export {
  detectSceneEntriesV2,
  handleModuleSceneDropV2,
  pendingModuleSceneEntriesV2,
  presentModuleSceneV2,
} from "./investigation-workspace-helpers";
export type { PendingModuleSceneEntryV2, SceneEntryV2 } from "./investigation-workspace-helpers";

interface ModuleSceneDropPayloadV1 {
  readonly kind: "module-scene";
  readonly moduleId: string;
  readonly revision: number;
  readonly sceneId: string;
}

/**
 * How long a submitted roll keeps its button locked while waiting for the
 * host's dice.result to come back through the relay. After this window the
 * command is treated as lost and the player may try again — the reducer
 * rejects a duplicate roll, so retrying can never double-spend the check.
 */
const ROLL_SETTLE_GRACE_MS = 15_000;

export function KeeperModuleWorkbenchV2({
  modulePackage,
  world,
  board,
  session,
  readOnly = false,
  onError,
}: {
  readonly modulePackage: ModulePackageV1;
  readonly world: RoomWorldStateV2;
  readonly board?: BoardV1;
  readonly session: RoomSessionV2;
  readonly readOnly?: boolean;
  readonly onError?: (message?: string) => void;
}) {
  const activeModuleSceneId = activeModuleSceneSourceId(world, modulePackage);
  const moduleSceneIds = modulePackage.scenes.map(({ id }) => id).join("\u0000");
  const [selectedSceneId, setSelectedSceneId] = useState(() => activeModuleSceneId ?? modulePackage.scenes[0]?.id ?? "");
  const [publicOpening, setPublicOpening] = useState("");
  const [clueQuery, setClueQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const entries = useMemo(() => detectSceneEntriesV2(world, board), [board, world]);
  const pendingSceneEntries = useMemo(
    () => pendingModuleSceneEntriesV2(world, modulePackage, board),
    [board, modulePackage, world],
  );
  const selectedScene = modulePackage.scenes.find(({ id }) => id === selectedSceneId)
    ?? modulePackage.scenes[0];
  const publishedScene = selectedScene
    ? findModuleEntityV2(world, modulePackage, selectedScene.id, "scene", { kind: "room" })
    : undefined;
  const isPresentedSceneActive = publishedScene !== undefined
    && world.activeSceneEntityId === publishedScene.entityId;
  const activePublishedScene = isPresentedSceneActive ? publishedScene : undefined;

  useEffect(() => {
    if (activeModuleSceneId) {
      setSelectedSceneId(activeModuleSceneId);
      return;
    }
    setSelectedSceneId((current) => modulePackage.scenes.some(({ id }) => id === current)
      ? current
      : modulePackage.scenes[0]?.id ?? "");
  }, [activeModuleSceneId, modulePackage.moduleId, modulePackage.revision, moduleSceneIds]);

  useEffect(() => {
    setPublicOpening(publishedScene?.description ?? "");
  }, [publishedScene?.entityId, publishedScene?.revision, selectedScene?.id]);

  const run = async (operation: () => Promise<void>) => {
    if (busy || readOnly) return;
    setBusy(true);
    onError?.(undefined);
    try {
      await operation();
    } catch (error) {
      onError?.(friendlyInvestigationError(error));
    } finally {
      setBusy(false);
    }
  };

  const sceneItem = selectedScene
    ? entries.find(({ scene }) => sourceRefId(scene) === selectedScene.id)?.sceneItem
    : undefined;
  const relatedLocations = selectedScene
    ? selectedScene.locationIds.flatMap((id) => modulePackage.locations.find((item) => item.id === id) ?? [])
    : [];
  const relatedNpcs = selectedScene
    ? selectedScene.npcIds.flatMap((id) => modulePackage.npcs.find((item) => item.id === id) ?? [])
    : [];
  const relatedClues = selectedScene
    ? selectedScene.clueIds.flatMap((id) => modulePackage.clues.find((item) => item.id === id) ?? [])
    : [];
  const relatedClueIds = new Set(relatedClues.map(({ id }) => id));
  const otherClues = modulePackage.clues.filter(({ id }) => !relatedClueIds.has(id));
  const normalizedClueQuery = clueQuery.trim().toLocaleLowerCase();
  const matchingOtherClues = normalizedClueQuery
    ? otherClues.filter((clue) => moduleClueSearchText(clue).includes(normalizedClueQuery))
    : otherClues;
  const relatedQueryMatchCount = normalizedClueQuery
    ? relatedClues.filter((clue) => moduleClueSearchText(clue).includes(normalizedClueQuery)).length
    : 0;
  const relatedChecks = selectedScene
    ? selectedScene.suggestedCheckIds.flatMap((id) => modulePackage.suggestedChecks.find((item) => item.id === id) ?? [])
    : [];
  // This component receives the complete local module package, including
  // Keeper-only notes. RoomView only mounts it for the host; keep the same
  // boundary here as defence in depth so a future caller cannot expose those
  // notes by accidentally reusing the workbench in a player view.
  if (!session.isHost) return null;

  return (
    <Panel id="keeper-scene-workbench" className="mb-4 grid gap-3 p-4" aria-label="推进当前场景">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><BookOpen className="h-4 w-4 text-brass" /><h2 className="text-sm font-semibold">推进当前场景</h2></div>
          <p className="mt-1 text-[11px] text-zinc-500">《{modulePackage.metadata.title}》已在本机打开；私密内容不会自动发给玩家。</p>
        </div>
        <span className="rounded bg-amber-950 px-2 py-1 text-[10px] text-amber-300">仅 KP</span>
      </div>

      <p className="rounded border border-zinc-800 bg-zinc-950 p-2 text-[11px] leading-4 text-zinc-500">
        先向玩家呈现当前情境，再根据行动公开地点、NPC 与线索。地图只是可选的视觉辅助；拖入地图只会建立不含剧情正文的标记。
      </p>

      {pendingSceneEntries.length > 0 && <section role="status" aria-label="调查员进入了另一个场景" className="grid gap-3 rounded-lg border border-amber-700/50 bg-amber-950/20 p-3">
        <div>
          <p className="text-sm font-semibold text-amber-100">地图上出现了需要 KP 回应的移动</p>
          <p className="mt-1 text-xs leading-5 text-zinc-400">移动棋子不会自动公开模组内容。若多人进入不同区域，请逐项查看，再决定玩家现在看见什么。</p>
        </div>
        <div className="grid gap-2">
          {pendingSceneEntries.map(({ entry, sourceId }) => <div key={entry.sceneItem.itemId} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-black/20 px-3 py-2">
            <p className="text-xs text-zinc-300"><b>{entry.characters.map(({ entity }) => entity.name).join("、")}</b>进入了“{entry.scene.name}”</p>
            <Button className="h-8 px-2 text-xs" variant="secondary" onClick={() => setSelectedSceneId(sourceId)}>
              查看并准备呈现：{entry.scene.name}
            </Button>
          </div>)}
        </div>
      </section>}

      <div className="grid max-h-48 gap-1 overflow-y-auto">
        {modulePackage.scenes.map((scene) => {
          const placed = entries.some(({ scene: entity }) => sourceRefId(entity) === scene.id);
          const roomScene = findModuleEntityV2(world, modulePackage, scene.id, "scene", { kind: "room" });
          const isCurrent = roomScene?.entityId === world.activeSceneEntityId;
          return <button
            key={scene.id}
            type="button"
            draggable={!readOnly && Boolean(board)}
            aria-label={`模组场景：${scene.name}`}
            aria-pressed={selectedScene?.id === scene.id}
            onClick={() => setSelectedSceneId(scene.id)}
            onDragStart={(event) => beginSceneDrag(event, modulePackage, scene)}
            className={`flex items-center gap-2 rounded border px-2 py-2 text-left text-xs ${selectedScene?.id === scene.id ? "border-brass/60 bg-brass/10" : "border-zinc-800 bg-zinc-950"}`}
          >
            <MapPin className="h-3.5 w-3.5 shrink-0 text-brass" />
            <span className="min-w-0 flex-1 truncate">{scene.name}</span>
            <span className={isCurrent || placed ? "text-emerald-300" : "text-zinc-600"}>{isCurrent ? "当前情境" : placed ? "已放到画面" : board ? "可拖到画面" : "未使用画面"}</span>
          </button>;
        })}
      </div>

      {selectedScene && <div className="grid gap-3 rounded-lg border border-zinc-800 bg-zinc-950/45 p-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">{selectedScene.name}</h3>
          <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-amber-100/70">{selectedScene.synopsis || selectedScene.description || "无场景摘要"}</p>
          {selectedScene.keeperNotes && <p className="mt-2 whitespace-pre-wrap rounded bg-amber-950/25 p-2 text-[11px] leading-4 text-amber-200/75">{selectedScene.keeperNotes}</p>}
        </div>
        <section className="grid gap-2 rounded-lg border border-brass/30 bg-brass/5 p-3" aria-label="向玩家呈现场景">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">玩家现在看见什么？</h3>
            <p className="mt-1 text-xs leading-5 text-zinc-400">只会发送你在这里写下的文字。上方模组摘要与主持人笔记不会自动带入。</p>
          </div>
          <Textarea
            aria-label="玩家可见的开场描述"
            value={publicOpening}
            maxLength={8_000}
            onChange={(event) => setPublicOpening(event.target.value)}
            placeholder="例如：雨水顺着剧院后门的铁皮棚流下。门缝里透出一线暖黄灯光，唱针摩擦声断断续续……"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={busy || readOnly || !publicOpening.trim()} onClick={() => void run(async () => {
              await presentModuleSceneV2(session, modulePackage, selectedScene, publicOpening);
            })}>
              <Eye className="mr-2 h-4 w-4" />
              {isPresentedSceneActive ? "更新当前情境" : "向所有人呈现这个场景"}
            </Button>
            {isPresentedSceneActive && <span className="text-xs text-emerald-300">玩家正在经历这里</span>}
          </div>
        </section>
        {board && !sceneItem && <Button disabled={busy || readOnly} variant="secondary" onClick={() => void run(async () => {
          await placeModuleSceneOnBoardV2(session, modulePackage, selectedScene, board.boardId, boardCenter(board));
        })}><PackagePlus className="mr-2 h-4 w-4" />放到当前地图中央</Button>}

        <WorkbenchGroup title="相关地点" empty="这个场景没有关联地点。">
          {relatedLocations.map((location) => {
            const roomLocation = findModuleEntityV2(world, modulePackage, location.id, "location", { kind: "room" });
            const alreadyPresented = Boolean(activePublishedScene && roomLocation && entityPresentedInSceneV2(roomLocation, activePublishedScene.entityId));
            return <ModulePublicationRow
              key={location.id}
              label={location.name}
              keeperDetail={location.description || "模组没有补充这个地点的 KP 参考。"}
              publicDetail={location.playerDescription || "未填写玩家可见描述"}
              status={alreadyPresented ? "玩家已看见" : "尚未公开"}
              disabled={busy || readOnly || !location.playerDescription?.trim() || !activePublishedScene || alreadyPresented}
              action={alreadyPresented ? "已在当前情境公开" : !publishedScene ? "先呈现这个场景" : !isPresentedSceneActive ? "先切换到此场景" : "让地点在当前情境登场"}
              onClick={() => void run(async () => {
                if (!activePublishedScene) throw new Error("请先把这个场景呈现为当前情境，再公开相关地点");
                await publishModuleLocationV2(session, modulePackage, location, activePublishedScene.entityId);
              })}
            />;
          })}
        </WorkbenchGroup>

        <WorkbenchGroup title="相关 NPC" empty="这个场景没有关联 NPC。">
          {relatedNpcs.map((npc, index) => {
            const roomNpc = findModuleEntityV2(world, modulePackage, npc.id, "npc", { kind: "room" });
            const alreadyPresented = Boolean(activePublishedScene && roomNpc && entityPresentedInSceneV2(roomNpc, activePublishedScene.entityId));
            const representationCount = board && roomNpc
              ? board.items.filter((item) => item.reference.kind === "entity" && item.reference.entityId === roomNpc.entityId).length
              : 0;
            return <div key={npc.id} className="grid gap-1">
              <ModulePublicationRow
                label={npc.name}
                keeperDetail={npcKeeperReference(npc)}
                publicDetail={npc.playerDescription || "未填写玩家可见摘要"}
                status={alreadyPresented ? "玩家已看见" : "尚未公开"}
                disabled={busy || readOnly || !npc.playerDescription?.trim() || !activePublishedScene || alreadyPresented}
                action={alreadyPresented ? "已在当前情境公开" : !publishedScene ? "先呈现这个场景" : !isPresentedSceneActive ? "先切换到此场景" : "让 NPC 在当前情境登场"}
                onClick={() => void run(async () => {
                  if (!activePublishedScene) throw new Error("请先把这个场景呈现为当前情境，再让相关人物登场");
                  await publishModuleNpcV2(session, modulePackage, npc, activePublishedScene.entityId);
                })}
              />
              {alreadyPresented && board && roomNpc && <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-dashed border-zinc-800 px-2 py-1.5 text-[11px] text-zinc-500">
                <span>{representationCount > 0 ? `当前画面已有 ${representationCount} 个表现棋子` : "人物已公开，但还没有放到画面上"}</span>
                <Button className="h-8 px-2 text-[11px]" variant="ghost" disabled={busy || readOnly} onClick={() => void run(async () => {
                  const origin = sceneItem?.position ?? boardCenter(board);
                  await placeEntityOnBoardV2(session, board.boardId, roomNpc, {
                    x: origin.x + 150 + (index + representationCount) * 45,
                    y: origin.y + 120 + (index + representationCount) * 35,
                  }, false, true);
                })}>{representationCount > 0 ? "再放一个 NPC 棋子" : "放一个 NPC 棋子到当前画面"}</Button>
              </div>}
            </div>;
          })}
        </WorkbenchGroup>

        <WorkbenchGroup title="建议检定" empty="这个场景没有建议检定。">
          {relatedChecks.map((check) => <div key={check.id} aria-label={`检定参考：${check.skill}`} className="rounded border border-zinc-800 bg-zinc-950 p-2 text-xs">
            <b>{check.skill} · {difficultyLabel(check.difficulty)}</b>
            <p className="mt-1 text-zinc-500">{check.purpose || "等玩家提交行动后，在现场直接裁定。"}</p>
            {(check.onSuccess || check.onFailure) && <div className="mt-2 grid gap-1 border-t border-zinc-800 pt-2 text-[11px] leading-4">
              <p className="text-emerald-300/80"><span className="font-semibold">成功：</span>{check.onSuccess || "按现场情况推进。"}</p>
              <p className="text-amber-300/80"><span className="font-semibold">失败：</span>{check.onFailure || "说明代价，并让调查继续。"}</p>
            </div>}
          </div>)}
        </WorkbenchGroup>

        <WorkbenchGroup title="与当前场景相关的线索" empty="这个场景没有预设关联线索；你仍可从下方搜索整个模组。">
          {relatedClues.map((clue) => <ModuleCluePublicationRow
            key={clue.id}
            clue={clue}
            modulePackage={modulePackage}
            world={world}
            disabled={busy || readOnly}
            sceneGuardAction={!publishedScene ? "先呈现这个场景" : !isPresentedSceneActive ? "先切换到此场景" : undefined}
            onPublish={() => void run(async () => { await publishModuleClueV2(session, modulePackage, clue); })}
          />)}
        </WorkbenchGroup>
      </div>}

      <section className="grid gap-2 rounded-lg border border-zinc-800 bg-zinc-950/35 p-3" aria-label="模组线索速查">
        <div>
          <h3 className="text-xs font-semibold text-zinc-200">{selectedScene ? "其他模组线索" : "全部模组线索"}</h3>
          <p className="mt-1 text-[11px] leading-4 text-zinc-500">
            调查方向改变或玩家卡住时，可以从整个模组寻找线索。当前场景之外的内容会标为“跨场景”，并在公开前再次请你确认。
          </p>
        </div>
        <Input
          aria-label="搜索全部模组线索"
          value={clueQuery}
          maxLength={120}
          onChange={(event) => setClueQuery(event.target.value)}
          placeholder="按线索名称或内容搜索……"
        />
        {normalizedClueQuery
          ? <div className="grid gap-1" aria-label="模组线索搜索结果">
            {matchingOtherClues.map((clue) => <ModuleCluePublicationRow
              key={clue.id}
              clue={clue}
              modulePackage={modulePackage}
              world={world}
              disabled={busy || readOnly}
              crossScene={Boolean(selectedScene)}
              currentSceneName={selectedScene?.name}
              onPublish={() => void run(async () => { await publishModuleClueV2(session, modulePackage, clue); })}
            />)}
            {matchingOtherClues.length === 0 && <p role="status" className="rounded border border-dashed border-zinc-800 p-3 text-[11px] leading-4 text-zinc-500">
              {relatedQueryMatchCount > 0
                ? `找到 ${relatedQueryMatchCount} 条当前场景线索，已显示在上方；没有额外的模组线索。`
                : `没有找到与“${clueQuery.trim()}”相符的线索。换个名称或关键词试试。`}
            </p>}
          </div>
          : selectedScene
            ? otherClues.length > 0
              ? <details className="rounded border border-zinc-800 bg-zinc-950/50">
                <summary className="cursor-pointer px-3 py-2 text-xs text-zinc-300 hover:text-zinc-100">浏览其他模组线索（{otherClues.length}）</summary>
                <div className="grid gap-1 border-t border-zinc-800 p-2">
                  {otherClues.map((clue) => <ModuleCluePublicationRow
                    key={clue.id}
                    clue={clue}
                    modulePackage={modulePackage}
                    world={world}
                    disabled={busy || readOnly}
                    crossScene
                    currentSceneName={selectedScene.name}
                    onPublish={() => void run(async () => { await publishModuleClueV2(session, modulePackage, clue); })}
                  />)}
                </div>
              </details>
              : <p className="text-[11px] leading-4 text-zinc-600">当前场景已经包含模组中的全部线索。</p>
            : modulePackage.clues.length > 0
              ? <div className="grid gap-1">
                {modulePackage.clues.map((clue) => <ModuleCluePublicationRow
                  key={clue.id}
                  clue={clue}
                  modulePackage={modulePackage}
                  world={world}
                  disabled={busy || readOnly}
                  onPublish={() => void run(async () => { await publishModuleClueV2(session, modulePackage, clue); })}
                />)}
              </div>
              : <p className="rounded border border-dashed border-zinc-800 p-3 text-[11px] leading-4 text-zinc-500">这个模组还没有可公开的线索。可以继续用聊天推进，或回到模组库补充玩家可见正文。</p>}
      </section>

      {entries.length > 0 && <div className="grid gap-1 rounded-lg border border-emerald-900/40 bg-emerald-950/10 p-3">
        <h3 className="text-xs font-semibold text-emerald-200">谁进入了场景区域</h3>
        {entries.map((entry) => <p key={entry.sceneItem.itemId} className="text-[11px] text-zinc-400">
          {entry.scene.name}：{entry.characters.length > 0 ? entry.characters.map(({ entity }) => entity.name).join("、") : "暂无调查员进入"}
        </p>)}
      </div>}

      {board && world.latestCharacters.size > 0 && <WorkbenchGroup title="调查员棋子" empty="房间中还没有角色卡。">
        {[...world.latestCharacters.values()].map((character, index) => {
          const entity = findCharacterEntity(world, character.id);
          const placed = entity && board.items.some((item) => item.reference.kind === "entity" && item.reference.entityId === entity.entityId);
          return <ModulePublicationRow
            key={character.id}
            label={character.name}
            detail={`${character.playerName} · ${character.occupation || "调查员"}`}
            disabled={busy || readOnly || Boolean(placed)}
            action={placed ? "已在画面" : "放置角色棋子"}
            onClick={() => void run(async () => {
              const nextEntity = await ensureCharacterEntityV2(session, character);
              await placeEntityOnBoardV2(session, board.boardId, nextEntity, {
                x: 120 + index * 120,
                y: Math.max(100, board.logicalSize.height - 130),
              });
            })}
          />;
        })}
      </WorkbenchGroup>}
    </Panel>
  );
}

export function CheckNegotiationV2({
  world,
  session,
  readOnly = false,
  waitingForKeeperOutcome = false,
  onError,
}: {
  readonly world: RoomWorldStateV2;
  readonly session?: RoomSessionV2;
  readonly readOnly?: boolean;
  /** The player's latest completed roll still needs a narrated consequence from KP. */
  readonly waitingForKeeperOutcome?: boolean;
  readonly onError?: (message?: string) => void;
}) {
  const ownCharacters = session
    ? [...world.latestCharacters.values()].filter(({ ownerPeerId }) => ownerPeerId === session.localSeat.seatId)
    : [];
  const [characterId, setCharacterId] = useState(ownCharacters[0]?.id ?? "");
  const character = ownCharacters.find(({ id }) => id === characterId) ?? ownCharacters[0];
  const checkOptions = character ? characterCheckOptions(character) : [];
  const [checkOptionId, setCheckOptionId] = useState("");
  const selectedCheck = checkOptions.find(({ id }) => id === checkOptionId);
  const [goal, setGoal] = useState("");
  const [approach, setApproach] = useState("");
  const [pushReason, setPushReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (character && character.id !== characterId) setCharacterId(character.id);
  }, [character, characterId]);

  useEffect(() => {
    if (checkOptionId && !selectedCheck) setCheckOptionId("");
  }, [checkOptionId, selectedCheck]);

  const run = async (operation: () => Promise<unknown>) => {
    if (!session || busy || readOnly) return;
    setBusy(true);
    onError?.(undefined);
    try { await operation(); }
    catch (error) { onError?.(friendlyInvestigationError(error)); }
    finally { setBusy(false); }
  };

  // For a non-host, session.rollDice resolves as soon as the command reaches
  // the transport — long before the host's dice.result comes back. A busy flag
  // cleared in `finally` would therefore re-enable the roll button within
  // microseconds, and a second click on a laggy relay produces a confusing
  // "someone just modified this" rejection. Instead the in-flight request ID
  // is held (via a ref, so a same-tick double click cannot slip past React's
  // batched state) until the world state shows the roll resolved or closed,
  // the submit fails locally, or a grace window elapses (a genuinely lost
  // command should become retryable).
  const [rollingRequestId, setRollingRequestId] = useState<string>();
  const rollingRef = useRef<string>();
  const clearRolling = (requestId: string) => {
    if (rollingRef.current !== requestId) return;
    rollingRef.current = undefined;
    setRollingRequestId((current) => (current === requestId ? undefined : current));
  };
  const beginAuthorizedRoll = (
    requestId: string,
    payload: Parameters<RoomSessionV2["rollDice"]>[0],
  ) => {
    if (!session || busy || readOnly || rollingRef.current !== undefined) return;
    rollingRef.current = requestId;
    setRollingRequestId(requestId);
    onError?.(undefined);
    void session.rollDice(payload).catch((error: unknown) => {
      onError?.(friendlyInvestigationError(error));
      clearRolling(requestId);
    });
  };
  useEffect(() => {
    if (rollingRequestId === undefined) return;
    const timer = globalThis.setTimeout(() => clearRolling(rollingRequestId), ROLL_SETTLE_GRACE_MS);
    return () => globalThis.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one grace window per in-flight roll
  }, [rollingRequestId]);
  useEffect(() => {
    if (rollingRequestId === undefined) return;
    if (
      world.checkAuthorizations.get(rollingRequestId)?.resolvedByEventId !== undefined
      || world.checkClosures.has(rollingRequestId)
    ) clearRolling(rollingRequestId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to world updates settling the roll
  }, [rollingRequestId, world]);

  const pending = [...world.checkRequests.values()].filter(({ requestId }) => !world.checkAuthorizations.has(requestId) && !world.checkClosures.has(requestId));
  const ownPending = pending.filter(({ requesterSeatId }) => requesterSeatId === session?.localSeat.seatId);
  const ready = [...world.checkAuthorizations.values()].filter(({ requestId, requesterSeatId, resolvedByEventId }) =>
    requesterSeatId === session?.localSeat.seatId
      && resolvedByEventId === undefined
      && !world.checkClosures.has(requestId),
  );
  const latestOwnCompletedAuthorization = [...world.checkAuthorizations.values()].filter(({ requestId, requesterSeatId, resolvedByEventId }) =>
    requesterSeatId === session?.localSeat.seatId
      && resolvedByEventId !== undefined
      && !world.checkClosures.has(requestId),
  ).at(-1);
  const latestOwnCompletedRequest = latestOwnCompletedAuthorization
    ? world.checkRequests.get(latestOwnCompletedAuthorization.requestId)
    : undefined;
  const pushCandidate = latestOwnCompletedAuthorization?.resolvedSuccess === false
    && latestOwnCompletedRequest !== undefined
    && latestOwnCompletedRequest.pushOfRequestId === undefined
    && world.checkOutcomes.has(latestOwnCompletedRequest.requestId)
    && !hasLiveOrConsumedPushV2(world, latestOwnCompletedRequest.requestId)
    ? latestOwnCompletedRequest
    : undefined;
  const readyPushCount = ready.filter(({ requestId }) => world.checkRequests.get(requestId)?.pushOfRequestId !== undefined).length;
  const pendingPushCount = pending.filter(({ pushOfRequestId }) => pushOfRequestId !== undefined).length;
  // Host view of every ruling still waiting for its dice. A mis-clicked
  // difficulty would otherwise be a dead end: the protocol forbids
  // re-authorizing, so the way out is an explicit cancellation.
  const authorizedAwaitingRoll = session?.isHost
    ? [...world.checkAuthorizations.values()].filter(({ requestId, resolvedByEventId }) =>
        resolvedByEventId === undefined && !world.checkClosures.has(requestId))
    : [];

  useEffect(() => {
    setPushReason("");
  }, [pushCandidate?.requestId]);

  const isPlayerChoosingAction = Boolean(
    session
      && !session.isHost
      && ownPending.length === 0
      && ready.length === 0
      && !waitingForKeeperOutcome,
  );
  const heading = session?.isHost
    ? pending.length > 0 ? pendingPushCount > 0 ? `需要说明强推代价 · ${pendingPushCount}` : `需要你裁定的行动 · ${pending.length}` : "等待调查员行动"
    : readyPushCount > 0 ? "先决定是否承担强推代价"
      : ready.length > 0 ? "KP 已允许你掷骰"
      : ownPending.length > 0 ? "行动已交给 KP"
        : waitingForKeeperOutcome ? "检定已完成，等待 KP 描述结果"
        : pushCandidate ? "第一次检定失败了"
        : "你想怎么做？";

  return <Panel className="mb-4 grid gap-3 border-brass/25 p-4" aria-label={session?.isHost ? "KP 裁定行动" : "我的行动"}>
    <div className="flex items-center gap-2"><Dices className="h-4 w-4 text-brass" /><h2 className="text-sm font-semibold">{heading}</h2></div>
    <p className="text-xs leading-5 text-zinc-500">{session?.isHost
      ? pending.length > 0 ? pendingPushCount > 0 ? "调查员换了一种做法。批准强推前，先明确告诉对方这次再失败会发生什么；由调查员听完后决定是否承担。" : "先判断是否真的存在不确定性：可以直接给出结果，也可以决定一次检定。" : "调查员提交需要裁定的行动后，会在这里出现。"
      : readyPushCount > 0 ? "先读清 KP 说明的严重后果。只有你明确接受后才会掷骰；不接受也可以继续调查。"
        : ready.length > 0 ? "这次检定已经确定，只需掷一次；结果会由房主生成并让所有人看见。"
        : ownPending.length > 0 ? "KP 会决定直接给出结果，还是让你掷骰。等待时仍可在现场继续交谈。"
          : waitingForKeeperOutcome ? "骰子结果已经记录。先听 KP 说明你达成了什么、现场发生了什么变化，再继续下一项行动。"
          : pushCandidate ? "你可以说明一种真正不同的做法申请强推。KP 会先告诉你再次失败的严重后果，看到后仍可放弃。"
          : "交谈或查看眼前明显信息时，直接用下方现场发言；结果可能有风险或不确定时，在这里提交行动让 KP 裁定。"}</p>

    {!readOnly && session && !session.isHost && (isPlayerChoosingAction || ownPending.length > 0) && <div className="grid gap-2 rounded border border-zinc-800 bg-zinc-950/50 p-3">
      {isPlayerChoosingAction && pushCandidate && <section aria-label="失败后可以申请强推" className="grid gap-2 rounded-lg border border-amber-800/60 bg-amber-950/15 p-3">
        <div>
          <h3 className="text-sm font-semibold text-amber-100">要换一种做法再试一次吗？</h3>
          <p className="mt-1 text-xs leading-5 text-zinc-400">刚才的 {latestOwnCompletedAuthorization?.skillName ?? pushCandidate.skillName} 检定没有成功。强推不是原样重掷，请说清这次换了什么做法。</p>
        </div>
        <Textarea aria-label="强推的新做法" value={pushReason} maxLength={1_000} onChange={(event) => setPushReason(event.target.value)} placeholder="例如：不再撬锁；我卸下铰链销，从门背面拨开锁舌。" />
        <Button disabled={busy || !pushReason.trim()} onClick={() => void run(async () => {
          await session.submitConfirmed({
            type: "check.requested",
            audience: pushCandidate.audience,
            payload: {
              requestId: crypto.randomUUID(),
              characterId: pushCandidate.characterId,
              characterName: pushCandidate.characterName,
              skillName: latestOwnCompletedAuthorization?.skillName ?? pushCandidate.skillName,
              proposedTarget: latestOwnCompletedAuthorization?.target ?? pushCandidate.proposedTarget,
              goal: pushCandidate.goal ?? pushCandidate.reason,
              approach: pushReason.trim(),
              suggestedSkillName: latestOwnCompletedAuthorization?.skillName ?? pushCandidate.skillName,
              reason: pushReason.trim(),
              pushOfRequestId: pushCandidate.requestId,
            },
          });
          setPushReason("");
        })}>换一种做法申请强推</Button>
      </section>}
      {isPlayerChoosingAction && (character ? <>
        {pushCandidate && <p className="pt-1 text-xs text-zinc-500">不想强推也没关系，可以直接在下面开始另一项行动。</p>}
        <Field label="想达到什么？" hint="先说目的，KP 才能判断是否需要检定。"><Input aria-label="行动目标" value={goal} maxLength={1_000} onChange={(event) => setGoal(event.target.value)} placeholder="例如：确认唱片机最近是否被人动过。" /></Field>
        <Field label="准备怎么做？"><Textarea aria-label="你想怎么做" value={approach} maxLength={1_000} onChange={(event) => setApproach(event.target.value)} placeholder="例如：我贴近唱片机，检查螺丝和外壳有没有新留下的拆卸痕迹。" /></Field>
        {ownCharacters.length > 1 && <Field label="由哪位调查员行动"><select aria-label="行动角色" className="h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm" value={character.id} onChange={(event) => {
          const nextCharacter = ownCharacters.find(({ id }) => id === event.target.value);
          setCharacterId(event.target.value);
          setCheckOptionId("");
        }}>{ownCharacters.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>}
        <Field label="我猜可能用到（可不选）"><select aria-label="使用技能或属性" className="h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm" value={selectedCheck?.id ?? ""} onChange={(event) => setCheckOptionId(event.target.value)}><option value="">不确定，让 KP 决定</option>{checkOptions.map((option) => <option key={option.id} value={option.id}>{option.name} · {option.value}{characteristicBandSuffix(option.name, option.value)}</option>)}</select></Field>
        <p className="text-xs leading-5 text-zinc-500">技能只是建议；KP 会根据你的目标和做法，决定直接给出结果或采用哪项检定。</p>
        <Button disabled={busy || !goal.trim() || !approach.trim()} onClick={() => void run(async () => {
          await session.submitConfirmed({
            type: "check.requested",
            audience: { kind: "room" },
            payload: {
              requestId: crypto.randomUUID(),
              characterId: character.id,
              characterName: character.name,
              skillName: selectedCheck?.name ?? "由 KP 决定",
              ...(selectedCheck ? { proposedTarget: selectedCheck.value, suggestedSkillName: selectedCheck.name } : {}),
              goal: goal.trim(),
              approach: approach.trim(),
              reason: approach.trim(),
            },
          });
          setGoal("");
          setApproach("");
          setCheckOptionId("");
        })}>提交行动，请 KP 裁定</Button>
      </> : <p className="text-xs text-amber-300">先保存并带入一名调查员，才能申请角色检定。</p>)}
      {ownPending.length > 0 && <section className="grid gap-2" aria-label="等待 KP 裁定的行动">{ownPending.map((request) => <article key={request.requestId} className="rounded bg-zinc-900/70 p-3">{request.pushOfRequestId && <span className="mb-2 inline-flex rounded bg-amber-950 px-2 py-1 text-[10px] font-semibold text-amber-200">强推申请</span>}<p className="text-[11px] font-semibold text-zinc-500">目标</p><p className="mt-1 text-xs leading-5 text-zinc-200">{request.goal ?? request.reason}</p><p className="mt-2 text-[11px] font-semibold text-zinc-500">做法</p><p className="mt-1 text-xs leading-5 text-zinc-300">{request.approach ?? request.reason}</p><p className="mt-2 text-[11px] text-zinc-500">{request.suggestedSkillName ? `你建议使用 ${request.suggestedSkillName}${request.proposedTarget ? `（${request.proposedTarget}）` : ""}` : "由 KP 决定是否检定及采用的技能"}{request.pushOfRequestId ? "；KP 正在确定再次失败的代价" : ""}</p><button type="button" disabled={busy} onClick={() => void run(() => session.submitConfirmed({ type: "check.closed", audience: request.audience, payload: { requestId: request.requestId, outcome: "cancelled", note: request.pushOfRequestId ? "调查员在得知失败代价前撤回了强推申请。" : "调查员撤回了行动申请。" } }))} className="mt-2 text-xs text-zinc-500 hover:text-zinc-200">{request.pushOfRequestId ? "撤回强推申请" : "撤回这个行动"}</button></article>)}</section>}
    </div>}

    {session?.isHost && pending.length > 0 && <div className="grid gap-2">
      <h3 className="text-xs font-semibold text-amber-200">待 KP 处理</h3>
      {pending.map((request) => <CheckRequestCard key={request.requestId} request={request} character={world.latestCharacters.get(request.characterId)} originalRequest={request.pushOfRequestId ? world.checkRequests.get(request.pushOfRequestId) : undefined} busy={busy || readOnly} onAuthorize={(decision) => void run(async () => {
        await session.submitConfirmed({
          type: "check.authorized",
          audience: request.audience,
          payload: { requestId: request.requestId, ...decision },
        });
      })} onClose={(outcome, note) => void run(() => session.submitConfirmed({
        type: "check.closed",
        audience: request.audience,
        payload: { requestId: request.requestId, outcome, note },
      }))} />)}
    </div>}

    {session?.isHost && authorizedAwaitingRoll.length > 0 && <div className="grid gap-2">
      <h3 className="text-xs font-semibold text-zinc-400">已裁定，等待调查员掷骰</h3>
      {authorizedAwaitingRoll.map((authorization) => {
        const request = world.checkRequests.get(authorization.requestId);
        if (!request) return null;
        const modifierLabel = bonusPenaltyLabelV2(authorization);
        const isPush = request.pushOfRequestId !== undefined;
        return <div key={authorization.requestId} className="flex flex-wrap items-center justify-between gap-2 rounded border border-zinc-800 bg-zinc-950/50 p-3 text-xs" aria-label={`等待掷骰：${request.characterName}`}>
          <p className="text-zinc-300">
            {request.characterName} · {isPush ? "强推 " : ""}{authorization.skillName ?? request.skillName} {authorization.target} · {difficultyLabel(authorization.requiredDifficulty)}{modifierLabel ? ` · ${modifierLabel}` : ""}
          </p>
          <Button className="h-8 px-2 text-[11px]" variant="ghost" disabled={busy || readOnly} onClick={() => void run(() => session.submitConfirmed({
            type: "check.closed",
            audience: request.audience,
            payload: { requestId: request.requestId, outcome: "cancelled", note: "KP 撤回了这次裁定；请重新提交行动，再由 KP 重新裁定。" },
          }))}>撤回裁定</Button>
        </div>;
      })}
    </div>}

    {ready.map((authorization) => {
      const request = world.checkRequests.get(authorization.requestId);
      if (!request) return null;
      const authorizedSkillName = authorization.skillName ?? request.skillName;
      const modifierLabel = bonusPenaltyLabelV2(authorization);
      const isRolling = rollingRequestId === request.requestId;
      const cardBusy = busy || readOnly || rollingRequestId !== undefined;
      if (request.pushOfRequestId !== undefined) {
        return <div key={authorization.requestId} className="grid gap-3 rounded border border-amber-700/60 bg-amber-950/20 p-3 text-xs" aria-label="决定是否进行强推">
          <div>
            <span className="inline-flex rounded bg-amber-900/60 px-2 py-1 text-[10px] font-semibold text-amber-100">强推 · 最后一次机会</span>
            <p className="mt-2 font-semibold text-zinc-200">你的新做法：{request.approach ?? request.reason}</p>
            <p className="mt-1 text-zinc-500">检定 {authorizedSkillName} {authorization.target} · {difficultyLabel(authorization.requiredDifficulty)}{modifierLabel ? ` · ${modifierLabel}` : ""}</p>
          </div>
          <div className="rounded-lg border border-red-800/60 bg-red-950/25 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-red-300">如果再次失败</p>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-red-100">{authorization.failureConsequence}</p>
          </div>
          {authorization.note && <p className="text-zinc-400">KP 补充：{authorization.note}</p>}
          <div className="flex flex-wrap gap-2">
            <Button disabled={cardBusy || !authorization.failureConsequence?.trim()} onClick={() => beginAuthorizedRoll(request.requestId, {
              expression: "1d100",
              reason: `强推 ${authorizedSkillName}：${request.approach ?? request.reason}`,
              bonusDice: authorization.bonusDice,
              penaltyDice: authorization.penaltyDice,
              target: authorization.target,
              requiredDifficulty: authorization.requiredDifficulty,
              checkRequestId: request.requestId,
            })}><Dices className="mr-2 h-4 w-4" />{isRolling ? "正在掷骰…" : "接受代价并强推"}</Button>
            <Button variant="secondary" disabled={cardBusy} onClick={() => void run(() => session!.submitConfirmed({
              type: "check.closed",
              audience: request.audience,
              payload: { requestId: request.requestId, outcome: "cancelled", note: "调查员知晓再次失败的代价后，决定不进行强推。" },
            }))}>不强推</Button>
          </div>
        </div>;
      }
      return <div key={authorization.requestId} className="grid gap-2 rounded border border-emerald-800/60 bg-emerald-950/15 p-3 text-xs" aria-label="KP 已允许的检定">
        <p className="font-semibold text-emerald-200">KP 已允许：{authorizedSkillName} {authorization.target} · {difficultyLabel(authorization.requiredDifficulty)}{modifierLabel ? ` · ${modifierLabel}` : ""}</p>
        <p className="text-zinc-400">目标：{request.goal ?? request.reason}</p>
        <p className="text-zinc-400">做法：{request.approach ?? request.reason}</p>
        {authorization.note && <p className="text-zinc-400">KP 补充：{authorization.note}</p>}
        <div className="flex flex-wrap gap-2">
          <Button disabled={cardBusy} onClick={() => beginAuthorizedRoll(request.requestId, {
            expression: "1d100",
            reason: `${authorizedSkillName}：${request.approach ?? request.reason}`,
            bonusDice: authorization.bonusDice,
            penaltyDice: authorization.penaltyDice,
            target: authorization.target,
            requiredDifficulty: authorization.requiredDifficulty,
            checkRequestId: request.requestId,
          })}><Dices className="mr-2 h-4 w-4" />{isRolling ? "正在掷骰…" : `掷骰：${authorizedSkillName}（${authorization.target}）`}</Button>
          <Button variant="secondary" disabled={cardBusy} onClick={() => void run(() => session!.submitConfirmed({
            type: "check.closed",
            audience: request.audience,
            payload: { requestId: request.requestId, outcome: "cancelled", note: "调查员在掷骰前放弃了这次检定，换一种做法继续调查。" },
          }))}>放弃这次检定</Button>
        </div>
      </div>;
    })}
  </Panel>;
}

export function PublicClueBoardV2({
  world,
  session,
  board,
  readOnly = false,
  onError,
  resolveAsset,
}: {
  readonly world: RoomWorldStateV2;
  readonly session?: RoomSessionV2;
  readonly board?: BoardV1;
  readonly readOnly?: boolean;
  readonly onError?: (message?: string) => void;
  readonly resolveAsset?: ResolveRoomAssetV2;
}) {
  const clues = [...world.artifacts.values()].filter((artifact) => artifact.kind === "clue" && !artifact.archived && artifact.audience.kind === "room");
  const ownCharacters = session
    ? [...world.latestCharacters.values()].filter(({ ownerPeerId }) => ownerPeerId === session.localSeat.seatId)
    : [];
  const [characterId, setCharacterId] = useState(ownCharacters[0]?.id ?? "");
  const character = ownCharacters.find(({ id }) => id === characterId) ?? ownCharacters[0];
  const [caseFileView, setCaseFileView] = useState<"all" | "personal">("all");
  const [busy, setBusy] = useState(false);
  const personal = character
    ? clues.filter((artifact) => (world.clueClaims.get(artifact.artifactId) ?? []).some(({ seatId, characterId: claimedCharacterId }) =>
        seatId === session?.localSeat.seatId && claimedCharacterId === character.id,
      ))
    : [];
  const showingPersonal = caseFileView === "personal" && Boolean(session && !session.isHost);
  const displayedClues = showingPersonal ? personal : clues;

  const run = async (operation: () => Promise<unknown>) => {
    if (!session || busy || readOnly) return;
    setBusy(true);
    onError?.(undefined);
    try { await operation(); }
    catch (error) { onError?.(friendlyInvestigationError(error)); }
    finally { setBusy(false); }
  };

  return <Panel className="grid gap-3 p-4" aria-label="调查案卷">
    <div className="flex items-start justify-between gap-2"><div><h2 className="font-serif text-lg">调查案卷</h2><p className="mt-1 max-w-2xl text-xs leading-5 text-zinc-500">这里是所有人都能看到的事实与线索。把重要内容加入自己的线索栏只是个人重点标记，不会拿走线索，也不会影响其他玩家。</p></div><span aria-label={`共 ${clues.length} 条公开线索`} className="shrink-0 rounded bg-zinc-900 px-2 py-1 text-xs text-brass">{clues.length} 条</span></div>
    {session && !session.isHost && <div role="group" aria-label="调查案卷视图" className="grid grid-cols-2 rounded-lg border border-zinc-800 bg-zinc-950 p-1">
      <button type="button" aria-pressed={!showingPersonal} onClick={() => setCaseFileView("all")} className={`rounded-md px-3 py-2 text-xs font-medium transition ${!showingPersonal ? "bg-brass/15 text-brass" : "text-zinc-500 hover:text-zinc-200"}`}>全部线索 <span aria-hidden="true">· {clues.length}</span></button>
      <button type="button" aria-pressed={showingPersonal} onClick={() => setCaseFileView("personal")} className={`rounded-md px-3 py-2 text-xs font-medium transition ${showingPersonal ? "bg-brass/15 text-brass" : "text-zinc-500 hover:text-zinc-200"}`}>我的重点 <span aria-hidden="true">· {personal.length}</span></button>
    </div>}
    {ownCharacters.length > 1 && <label className="grid max-w-sm gap-1 text-xs text-zinc-500">整理哪位调查员的线索栏？<select aria-label="整理哪位调查员的线索栏" className="h-9 rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-200" value={character?.id ?? ""} onChange={(event) => setCharacterId(event.target.value)}>{ownCharacters.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    {session && !session.isHost && ownCharacters.length === 0 && !showingPersonal && <div role="status" className="rounded-lg border border-amber-900/50 bg-amber-950/10 p-3 text-xs leading-5 text-amber-200">
      你仍然可以阅读共同案卷。想整理“我的线索栏”，请先在“我的调查员”中保存角色并带入房间。
    </div>}
    <div className="grid gap-2 md:grid-cols-2" aria-label={showingPersonal ? "我的重点列表" : "全部线索列表"}>
      {displayedClues.length === 0 && <div className="rounded-lg border border-dashed border-zinc-800 p-4 md:col-span-2">
        {showingPersonal ? <>
          <p className="text-sm text-zinc-400">{!character ? "还不能整理我的重点。" : clues.length === 0 ? "共同案卷还没有公开线索。" : "我的重点还是空的。"}</p>
          <p className="mt-1 text-xs leading-5 text-zinc-600">{!character
            ? "先在“我的调查员”中保存角色并带入房间；你仍然可以切回全部线索阅读共同案卷。"
            : clues.length === 0
              ? "KP 公开新发现后，它会先出现在全部线索中。"
              : "切回全部线索，遇到值得追查的内容时点“加入我的线索栏”。"}</p>
          <Button className="mt-3 h-8 text-xs" variant="secondary" onClick={() => setCaseFileView("all")}>查看全部线索</Button>
        </> : <>
          <p className="text-sm text-zinc-400">共同案卷还是空的。</p>
          <p className="mt-1 text-xs leading-5 text-zinc-600">{session?.isHost
            ? "当调查员的行动带来新发现时，从当前场景中选择对应线索并公开到这里。"
            : session
              ? "先从现场开始调查；KP 公开新发现后，线索会自动出现在这里。"
              : "这份记录中没有公开线索。"}</p>
        </>}
      </div>}
      {displayedClues.map((artifact, index) => {
        const claims = world.clueClaims.get(artifact.artifactId) ?? [];
        const claimed = claims.some(({ seatId, characterId: claimedCharacterId }) => seatId === session?.localSeat.seatId && claimedCharacterId === character?.id);
        const placed = board?.kind === "evidence" && board.items.some((item) => item.reference.kind === "artifact" && item.reference.artifactId === artifact.artifactId);
        const claimNames = [...new Set(claims.map(({ characterName }) => characterName))];
        return <article key={artifact.artifactId} className="rounded-lg border border-emerald-900/40 bg-emerald-950/10 p-3">
          <div className="flex items-center gap-2"><Eye className="h-3.5 w-3.5 text-emerald-300" /><h3 className="text-sm font-semibold text-emerald-100">{artifact.title}</h3></div>
          <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-zinc-300">{artifact.body}</p>
          <ArtifactAttachmentViewerV2 artifact={artifact} resolveAsset={resolveAsset} />
          {claimNames.length > 0 && <p className="mt-2 text-xs text-zinc-500">正在重点追查：{claimNames.join("、")}</p>}
          {!readOnly && session && !session.isHost && <Button
            className="mt-2 h-8 text-xs"
            variant={claimed ? "ghost" : "secondary"}
            disabled={busy || !character}
            onClick={() => void run(() => session.submitConfirmed(claimed ? {
              type: "clue.unclaimed",
              audience: { kind: "room" },
              payload: { artifactId: artifact.artifactId, characterId: character!.id, characterName: character!.name },
            } : {
              type: "clue.claimed",
              audience: { kind: "room" },
              payload: { artifactId: artifact.artifactId, characterId: character!.id, characterName: character!.name },
            }))}
          >{claimed ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <PackagePlus className="mr-1.5 h-3.5 w-3.5" />}{claimed ? "移出我的重点" : "加入我的线索栏"}</Button>}
          {!readOnly && session && board?.kind === "evidence" && <Button className="mt-2 h-8 text-xs" variant="ghost" disabled={busy || placed} onClick={() => void run(() => placeArtifactOnBoardV2(session, board.boardId, artifact, { x: 220 + (index % 3) * 360, y: 180 + Math.floor(index / 3) * 230 }))}>{placed ? "已放到大家的推理板" : "放到大家的推理板"}</Button>}
        </article>;
      })}
    </div>
  </Panel>;
}

async function publishModuleLocationV2(session: RoomSessionV2, modulePackage: ModulePackageV1, location: ModuleLocationV1, sceneEntityId: string) {
  const description = location.playerDescription?.trim();
  if (!description) throw new Error(`地点“${location.name}”没有玩家可见描述`);
  const entity = await ensureModuleEntityV2(session, modulePackage, { sourceId: location.id, kind: "location", name: location.name, description, audience: { kind: "room" } });
  return attachEntityPresentationV2(session, entity, sceneEntityId);
}

async function publishModuleNpcV2(session: RoomSessionV2, modulePackage: ModulePackageV1, npc: ModuleNpcV1, sceneEntityId: string) {
  const description = npc.playerDescription?.trim();
  if (!description) throw new Error(`人物“${npc.name}”还没有可公开的介绍`);
  const entity = await ensureModuleEntityV2(session, modulePackage, { sourceId: npc.id, kind: "npc", name: npc.name, description, audience: { kind: "room" } });
  return attachEntityPresentationV2(session, entity, sceneEntityId);
}

async function publishModuleClueV2(session: RoomSessionV2, modulePackage: ModulePackageV1, clue: ModuleClueV1) {
  if (!clue.revealText.trim()) throw new Error(`线索“${clue.name}”没有玩家可见正文`);
  const existing = findModuleClueArtifactV2(session.world, modulePackage, clue.id);
  if (existing) {
    if (!existing.archived) return existing;
    const restored = { ...existing, revision: existing.revision + 1, archived: false };
    await session.submitConfirmed({ type: "artifact.upserted", audience: restored.audience, payload: { artifact: restored } });
    return session.world.artifacts.get(restored.artifactId) ?? restored;
  }
  const artifact: RoomArtifactV2 = {
    schemaVersion: 2,
    artifactId: crypto.randomUUID(),
    revision: 1,
    kind: "clue",
    title: clue.name,
    // `description` is the KP-side clue explanation. Only the explicitly
    // player-facing reveal text may cross the room boundary.
    description: "",
    body: clue.revealText,
    attachments: [],
    sourceEntityId: clue.id,
    audience: { kind: "room" },
    locked: true,
    archived: false,
    extensions: { sourceRef: { moduleId: modulePackage.moduleId, revision: modulePackage.revision, kind: "clue", id: clue.id } },
  };
  await session.submitConfirmed({ type: "artifact.upserted", audience: artifact.audience, payload: { artifact } });
  return session.world.artifacts.get(artifact.artifactId) ?? artifact;
}

async function ensureCharacterEntityV2(session: RoomSessionV2, character: Coc7Character): Promise<RoomEntityV2> {
  const existing = findCharacterEntity(session.world, character.id);
  if (existing) return existing;
  const entity: RoomEntityV2 = {
    schemaVersion: 2,
    entityId: crypto.randomUUID(),
    revision: 1,
    kind: "character",
    name: character.name,
    description: character.occupation || "调查员",
    artifactIds: [],
    audience: { kind: "room" },
    data: { characterId: character.id, ownerSeatId: character.ownerPeerId, roomRole: "character-token" },
    extensions: {},
  };
  await session.submitConfirmed({ type: "entity.upserted", audience: entity.audience, payload: { entity } });
  return session.world.entities.get(entity.entityId) ?? entity;
}

export async function attachEntityPresentationV2(
  session: RoomSessionV2,
  entity: RoomEntityV2,
  sceneEntityId: string,
): Promise<RoomEntityV2> {
  const currentIds = Array.isArray(entity.data.presentedInSceneEntityIds)
    ? entity.data.presentedInSceneEntityIds.filter((value): value is string => typeof value === "string")
    : [];
  if (currentIds.includes(sceneEntityId)) return entity;
  const next: RoomEntityV2 = {
    ...entity,
    revision: entity.revision + 1,
    data: {
      ...entity.data,
      // This is a public presentation link, not ownership. An NPC/location
      // remains independent and may appear in several scenes or boards.
      presentedInSceneEntityIds: [...currentIds, sceneEntityId],
    },
  };
  await session.submitConfirmed({ type: "entity.upserted", audience: next.audience, payload: { entity: next } });
  return session.world.entities.get(next.entityId) ?? next;
}

async function placeArtifactOnBoardV2(session: RoomSessionV2, boardId: string, artifact: RoomArtifactV2, point: BoardPointV1) {
  const board = session.world.boards.get(boardId);
  if (!board || board.kind !== "evidence" || board.archived) throw new Error("当前没有可用的推理板，请先打开一个线索画面");
  if (!isAudienceSubsetV2(board.audience, artifact.audience)) throw new Error("这条线索只给部分人看，不能放到所有人可见的推理板上");
  const item: BoardItemV1 = {
    schemaVersion: 1,
    itemId: crypto.randomUUID(),
    reference: { kind: "artifact", artifactId: artifact.artifactId },
    label: artifact.title,
    position: clampBoardPoint(point, board),
    size: { width: 310, height: 180 },
    rotationDegrees: 0,
    scale: 1,
    zIndex: board.items.length,
    locked: false,
    audience: board.audience,
    extensions: { roomRole: "clue-card" },
  };
  await session.submitConfirmed({ type: "board.item.upserted", audience: board.audience, payload: { boardId, boardRevision: board.revision + 1, item } });
}

function CheckRequestCard({ request, character, originalRequest, busy, onAuthorize, onClose }: {
  readonly request: CheckRequestV2;
  readonly character?: Coc7Character;
  readonly originalRequest?: CheckRequestV2;
  readonly busy: boolean;
  readonly onAuthorize: (decision: {
    skillName: string;
    target: number;
    requiredDifficulty: CheckDifficulty;
    bonusDice: number;
    penaltyDice: number;
    note: string;
    failureConsequence?: string;
  }) => void;
  readonly onClose: (outcome: "no-roll" | "declined", note: string) => void;
}) {
  const isPush = request.pushOfRequestId !== undefined;
  const availableChecks = character ? characterCheckOptions(character) : [];
  const suggestedSkillName = request.suggestedSkillName ?? (request.skillName === "由 KP 决定" ? undefined : request.skillName);
  const suggestedCheck = availableChecks.find(({ name }) => name === suggestedSkillName);
  const [checkOptionId, setCheckOptionId] = useState(suggestedCheck?.id ?? availableChecks[0]?.id ?? "legacy");
  const selectedCheck = availableChecks.find(({ id }) => id === checkOptionId)
    ?? { id: "legacy", name: suggestedSkillName ?? request.skillName, value: request.proposedTarget ?? 50 };
  const [target, setTarget] = useState(suggestedCheck?.value ?? request.proposedTarget ?? selectedCheck.value);
  const [modifier, setModifier] = useState(0);
  const [decisionMode, setDecisionMode] = useState<"result" | "roll" | "declined">(isPush ? "roll" : "result");
  const [rulingText, setRulingText] = useState("");
  const [rollNote, setRollNote] = useState("");
  const [failureConsequence, setFailureConsequence] = useState("");
  const authorize = (requiredDifficulty: CheckDifficulty) => onAuthorize({
    skillName: selectedCheck.name,
    target,
    requiredDifficulty,
    bonusDice: Math.max(0, modifier),
    penaltyDice: Math.max(0, -modifier),
    note: rollNote.trim() || (isPush ? "KP 已说明强推再次失败的代价。" : "KP 已允许本次检定。"),
    ...(isPush ? { failureConsequence: failureConsequence.trim() } : {}),
  });
  const approvalDisabled = busy || !selectedCheck.name.trim() || (isPush && !failureConsequence.trim());
  return <article className={`rounded border p-3 text-xs ${isPush ? "border-amber-700/60 bg-amber-950/25" : "border-amber-900/50 bg-amber-950/15"}`} aria-label={isPush ? `强推申请：${request.characterName}` : `检定申请：${request.characterName}`}>
    <div className="flex flex-wrap items-center gap-2"><UserRound className="h-3.5 w-3.5 text-brass" /><b>{request.characterName} 提交了一项行动</b>{isPush && <span className="rounded bg-amber-900/60 px-2 py-1 text-[10px] font-semibold text-amber-100">强推申请</span>}</div>
    <div className="mt-2 grid gap-2 rounded-lg bg-black/20 p-3">
      <div><span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">想达到</span><p className="mt-1 text-zinc-200">{request.goal ?? originalRequest?.goal ?? request.reason}</p></div>
      {isPush && originalRequest && <div><span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">第一次做法</span><p className="mt-1 text-zinc-500">{originalRequest.approach ?? originalRequest.reason}</p></div>}
      <div><span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">{isPush ? "改用做法" : "准备这样做"}</span><p className="mt-1 text-zinc-300">{request.approach ?? request.reason}</p></div>
      <p className="text-[11px] text-zinc-500">{suggestedSkillName ? `玩家建议：${suggestedSkillName}${request.proposedTarget ? ` ${request.proposedTarget}` : ""}` : "玩家没有指定技能，由 KP 裁定。"}</p>
    </div>
    <div role="group" aria-label={`如何裁定 ${request.characterName} 的行动`} className="mt-3 grid grid-cols-3 rounded-lg border border-zinc-800 bg-zinc-950 p-1">
      <button type="button" aria-pressed={decisionMode === "result"} disabled={busy} onClick={() => setDecisionMode("result")} className={`rounded px-2 py-2 text-[11px] font-medium ${decisionMode === "result" ? "bg-emerald-950 text-emerald-200" : "text-zinc-500 hover:text-zinc-200"}`}>直接给结果</button>
      <button type="button" aria-pressed={decisionMode === "roll"} disabled={busy} onClick={() => setDecisionMode("roll")} className={`rounded px-2 py-2 text-[11px] font-medium ${decisionMode === "roll" ? "bg-brass/15 text-brass" : "text-zinc-500 hover:text-zinc-200"}`}>需要检定</button>
      <button type="button" aria-pressed={decisionMode === "declined"} disabled={busy} onClick={() => setDecisionMode("declined")} className={`rounded px-2 py-2 text-[11px] font-medium ${decisionMode === "declined" ? "bg-zinc-800 text-zinc-200" : "text-zinc-500 hover:text-zinc-200"}`}>当前不可行</button>
    </div>
    {decisionMode === "result" && <div className="mt-3 grid gap-2 rounded-lg border border-emerald-900/50 bg-emerald-950/10 p-3">
      <Field label="玩家现在直接得到什么结果？" hint="这段话会作为本次行动的正式结算发给对应玩家。"><Textarea aria-label={`直接结果：${request.characterName}`} aria-required="true" value={rulingText} maxLength={4_000} onChange={(event) => setRulingText(event.target.value)} placeholder="例如：信件就摊在桌面上，你不用检定便看见了落款和日期。" /></Field>
      <Button className="justify-self-start" disabled={busy || !rulingText.trim()} onClick={() => onClose("no-roll", rulingText.trim())}>无需掷骰，直接给出结果</Button>
    </div>}
    {decisionMode === "declined" && <div className="mt-3 grid gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
      <Field label="为什么当前不可行？" hint="指出眼前限制，玩家便能换一种目标或做法。"><Textarea aria-label={`不可行原因：${request.characterName}`} aria-required="true" value={rulingText} maxLength={4_000} onChange={(event) => setRulingText(event.target.value)} placeholder="例如：门从里面焊死，撬锁无法解决；需要寻找另一条进入路线。" /></Field>
      <Button className="justify-self-start" variant="secondary" disabled={busy || !rulingText.trim()} onClick={() => onClose("declined", rulingText.trim())}>说明原因并退回行动</Button>
    </div>}
    {decisionMode === "roll" && <div className="mt-3 grid gap-3 rounded-lg border border-amber-900/40 bg-amber-950/10 p-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label="实际采用的技能"><select aria-label={`实际检定技能：${request.characterName}`} className="h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm" value={selectedCheck.id} onChange={(event) => {
          const next = availableChecks.find(({ id }) => id === event.target.value);
          setCheckOptionId(event.target.value);
          if (next) setTarget(next.value);
        }}>{availableChecks.length > 0 ? availableChecks.map((option) => <option key={option.id} value={option.id}>{option.name} · {option.value}{characteristicBandSuffix(option.name, option.value)}</option>) : <option value="legacy">{selectedCheck.name} · {selectedCheck.value}</option>}</select></Field>
        <Field label="采用的角色卡数值"><Input aria-label={`检定目标：${request.characterName}`} type="number" min={1} max={100} value={target} onChange={(event) => setTarget(clampTarget(Number(event.target.value)))} /></Field>
        <Field label="奖惩骰"><select aria-label={`奖惩骰：${request.characterName}`} className="h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm" value={modifier} onChange={(event) => setModifier(Number(event.target.value))}><option value={2}>2 个奖励骰</option><option value={1}>1 个奖励骰</option><option value={0}>无奖惩骰</option><option value={-1}>1 个惩罚骰</option><option value={-2}>2 个惩罚骰</option></select></Field>
      </div>
      <Input aria-label={`KP 裁定说明：${request.characterName}`} value={rollNote} maxLength={4_000} onChange={(event) => setRollNote(event.target.value)} placeholder={isPush ? "可选：补充难度或适用范围" : "可选：说明风险、范围或失败表现"} />
      {isPush && <div className="grid gap-1.5 rounded-lg border border-red-900/60 bg-red-950/20 p-3">
        <label htmlFor={`push-consequence-${request.requestId}`} className="text-xs font-semibold text-red-200">如果强推再次失败，会发生什么？</label>
        <Textarea id={`push-consequence-${request.requestId}`} aria-label={`强推失败代价：${request.characterName}`} aria-required="true" value={failureConsequence} maxLength={4_000} onChange={(event) => setFailureConsequence(event.target.value)} placeholder="写具体且更严重的后果，例如：工具会折断，巨响惊醒地下沉睡的东西。" />
        <p className="text-[11px] leading-4 text-zinc-500">这段话会先完整展示给调查员；对方接受后才掷骰，也可以选择不强推。</p>
      </div>}
      <div className="flex flex-wrap gap-1"><Button className="h-8 text-xs" disabled={approvalDisabled} onClick={() => authorize("regular")}>{isPush ? "允许强推（普通）" : "需要普通检定"}</Button><Button className="h-8 text-xs" variant="secondary" disabled={approvalDisabled} onClick={() => authorize("hard")}>{isPush ? "允许强推（困难）" : "需要困难检定"}</Button><Button className="h-8 text-xs" variant="secondary" disabled={approvalDisabled} onClick={() => authorize("extreme")}>{isPush ? "允许强推（极难）" : "需要极难检定"}</Button></div>
      {isPush && !failureConsequence.trim() && <p className="text-[11px] text-amber-300">先写明再次失败的严重代价，才能把强推交给调查员决定。</p>}
    </div>}
  </article>;
}

function ModuleCluePublicationRow({
  clue,
  modulePackage,
  world,
  disabled,
  sceneGuardAction,
  crossScene = false,
  currentSceneName,
  onPublish,
}: {
  readonly clue: ModuleClueV1;
  readonly modulePackage: ModulePackageV1;
  readonly world: RoomWorldStateV2;
  readonly disabled: boolean;
  readonly sceneGuardAction?: string;
  readonly crossScene?: boolean;
  readonly currentSceneName?: string;
  readonly onPublish: () => void;
}) {
  const [confirmingCrossScene, setConfirmingCrossScene] = useState(false);
  const roomClue = findModuleClueArtifactV2(world, modulePackage, clue.id);
  const alreadyPublished = Boolean(roomClue && !roomClue.archived);
  const archived = roomClue?.archived === true;
  const sourceSceneNames = modulePackage.scenes
    .filter((scene) => scene.clueIds.includes(clue.id))
    .map((scene) => scene.name);
  const blockedByScene = Boolean(sceneGuardAction) && !alreadyPublished;
  const action = alreadyPublished
    ? "已在调查案卷"
    : sceneGuardAction
      ? sceneGuardAction
      : crossScene
        ? "跨场景发布…"
        : archived
          ? "重新放回调查案卷"
          : "公开到调查案卷";
  return <div className="grid gap-1" aria-label={`模组线索：${clue.name}`}>
    <ModulePublicationRow
      label={`${clue.isCore ? "核心 · " : ""}${clue.name}`}
      keeperDetail={clue.description || "模组没有补充这条线索的真实含义。"}
      publicDetail={clue.revealText || "未填写玩家可见正文"}
      status={alreadyPublished ? "已进入共同案卷" : archived ? "已收起" : "尚未公开"}
      warning={crossScene ? "跨场景" : undefined}
      disabled={disabled || !clue.revealText.trim() || alreadyPublished || blockedByScene}
      action={action}
      onClick={crossScene && !alreadyPublished ? () => setConfirmingCrossScene(true) : onPublish}
    />
    {crossScene && !alreadyPublished && confirmingCrossScene && <div
      role="alert"
      aria-label={`跨场景发布确认：${clue.name}`}
      className="grid gap-2 rounded border border-amber-700/60 bg-amber-950/25 p-2 text-[11px] leading-4 text-amber-100"
    >
      <p>
        这是跨场景内容：线索关联{sourceSceneNames.length > 0 ? `“${sourceSceneNames.join("、")}”` : "其他模组资料"}，
        不是当前查看的“{currentSceneName ?? "未选择场景"}”。请确认调查员确实通过其他途径获得了它。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button className="h-8 px-2 text-[11px]" disabled={disabled} onClick={() => {
          setConfirmingCrossScene(false);
          onPublish();
        }}>确认跨场景公开</Button>
        <Button className="h-8 px-2 text-[11px]" variant="ghost" disabled={disabled} onClick={() => setConfirmingCrossScene(false)}>取消</Button>
      </div>
    </div>}
  </div>;
}

function ModulePublicationRow({ label, detail, keeperDetail, publicDetail, status, warning, action, disabled, onClick }: {
  readonly label: string;
  readonly detail?: string;
  readonly keeperDetail?: string;
  readonly publicDetail?: string;
  readonly status?: string;
  readonly warning?: string;
  readonly action: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return <div className="rounded border border-zinc-800 bg-zinc-950 p-2 text-xs">
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <b className="text-zinc-200">{label}</b>
          {status && <span className={`rounded px-1.5 py-0.5 text-[9px] ${status.includes("已") || status.includes("看见") ? "bg-emerald-950/60 text-emerald-300" : "bg-zinc-900 text-zinc-600"}`}>{status}</span>}
          {warning && <span className="rounded bg-amber-950/70 px-1.5 py-0.5 text-[9px] text-amber-300">{warning}</span>}
        </div>
        {keeperDetail && <PublicationReference label={`仅 KP 参考：${label}`} prefix="仅 KP" text={keeperDetail} tone="keeper" />}
        {publicDetail && <PublicationReference label={`公开预览：${label}`} prefix="玩家会看到" text={publicDetail} tone="public" />}
        {detail && <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[11px] leading-4 text-zinc-500">{detail}</p>}
      </div>
      <Button className="h-8 shrink-0 px-2 text-[11px]" variant="secondary" disabled={disabled} onClick={onClick}>{action}</Button>
    </div>
  </div>;
}

function PublicationReference({ label, prefix, text, tone }: {
  readonly label: string;
  readonly prefix: string;
  readonly text: string;
  readonly tone: "keeper" | "public";
}) {
  const color = tone === "keeper" ? "text-amber-200/75" : "text-zinc-500";
  const prefixColor = tone === "keeper" ? "text-amber-200/90" : "text-zinc-400";
  if (text.length <= 240) {
    return <p aria-label={label} className={`mt-1 whitespace-pre-wrap text-[11px] leading-4 ${color}`}><span className={`font-semibold ${prefixColor}`}>{prefix}：</span>{text}</p>;
  }
  return <details aria-label={label} className={`mt-1 text-[11px] leading-4 ${color}`}>
    <summary className="cursor-pointer list-none hover:text-zinc-300"><span className={`font-semibold ${prefixColor}`}>{prefix}：</span>{shortReference(text)} <span className="whitespace-nowrap text-zinc-600">展开全文</span></summary>
    <p className="mt-1 whitespace-pre-wrap border-l border-zinc-800 pl-2">{text}</p>
  </details>;
}

function WorkbenchGroup({ title, empty, children }: { readonly title: string; readonly empty: string; readonly children: React.ReactNode }) {
  const values = Array.isArray(children) ? children : children ? [children] : [];
  return <section className="grid gap-1"><h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{title}</h3>{values.length > 0 ? children : <p className="text-[11px] text-zinc-600">{empty}</p>}</section>;
}

function beginSceneDrag(event: DragEvent<HTMLButtonElement>, modulePackage: ModulePackageV1, scene: ModuleSceneV1) {
  const payload: ModuleSceneDropPayloadV1 = { kind: "module-scene", moduleId: modulePackage.moduleId, revision: modulePackage.revision, sceneId: scene.id };
  event.dataTransfer.setData(BOARD_EXTERNAL_DROP_MIME, JSON.stringify(payload));
  event.dataTransfer.effectAllowed = "copy";
}

function findCharacterEntity(world: RoomWorldStateV2, characterId: string) {
  return [...world.entities.values()].find((entity) => entity.kind === "character" && entity.data.characterId === characterId);
}

function sourceRefId(entity: RoomEntityV2): string | undefined {
  const sourceRef = entity.data.sourceRef;
  return isRecord(sourceRef) && typeof sourceRef.id === "string" ? sourceRef.id : undefined;
}

function entityPresentedInSceneV2(entity: RoomEntityV2, sceneEntityId: string): boolean {
  return Array.isArray(entity.data.presentedInSceneEntityIds)
    && entity.data.presentedInSceneEntityIds.some((value) => value === sceneEntityId);
}

function findModuleClueArtifactV2(
  world: RoomWorldStateV2,
  modulePackage: ModulePackageV1,
  clueId: string,
): RoomArtifactV2 | undefined {
  return [...world.artifacts.values()].find((artifact) => {
    if (artifact.kind !== "clue" || artifact.audience.kind !== "room") return false;
    const sourceRef = artifact.extensions.sourceRef;
    return isRecord(sourceRef)
      && sourceRef.moduleId === modulePackage.moduleId
      && sourceRef.revision === modulePackage.revision
      && sourceRef.kind === "clue"
      && sourceRef.id === clueId;
  });
}

function npcKeeperReference(npc: ModuleNpcV1): string {
  const details = [
    npc.description,
    npc.role ? `身份：${npc.role}` : "",
    npc.motivation ? `动机：${npc.motivation}` : "",
    npc.traits.length > 0 ? `扮演提示：${npc.traits.join("、")}` : "",
  ].filter((value) => value.trim().length > 0);
  return details.join("\n") || "模组没有补充这位人物的 KP 参考。";
}

function shortReference(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 180 ? compact : `${compact.slice(0, 180).trimEnd()}…`;
}

function moduleClueSearchText(clue: ModuleClueV1): string {
  return [clue.name, clue.description, clue.revealText]
    .join("\n")
    .toLocaleLowerCase();
}

function activeModuleSceneSourceId(
  world: RoomWorldStateV2,
  modulePackage: ModulePackageV1,
): string | undefined {
  const activeScene = world.activeSceneEntityId
    ? world.entities.get(world.activeSceneEntityId)
    : undefined;
  if (!activeScene || activeScene.kind !== "scene") return undefined;
  const sourceRef = activeScene.data.sourceRef;
  if (
    !isRecord(sourceRef)
    || sourceRef.moduleId !== modulePackage.moduleId
    || sourceRef.revision !== modulePackage.revision
    || sourceRef.kind !== "scene"
    || typeof sourceRef.id !== "string"
  ) return undefined;
  return modulePackage.scenes.some(({ id }) => id === sourceRef.id)
    ? sourceRef.id
    : undefined;
}

function boardCenter(board: BoardV1): BoardPointV1 { return { x: Math.round(board.logicalSize.width / 2), y: Math.round(board.logicalSize.height / 2) }; }
function clampTarget(value: number) { return Number.isFinite(value) ? Math.max(1, Math.min(100, Math.round(value))) : 1; }
function difficultyLabel(value: CheckDifficulty) { return value === "regular" ? "普通" : value === "hard" ? "困难" : "极难"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function friendlyInvestigationError(error: unknown): string {
  if (error instanceof RoomCommandRejectedError) {
    switch (error.code) {
      case "PAUSED": return "房主暂时离线，房间已经暂停。连接恢复后再试。";
      case "FORBIDDEN": return "你现在不能执行这个操作。内容可能只给部分人看，或已被 KP 设为只读。";
      case "CONFLICT": return "另一位成员刚刚更新了这里。等画面刷新后，再试一次。";
      case "INVALID": return "这次操作没有完成，请检查填写的内容后再试。";
      case "INTERNAL": return "刚才的操作没有完成。你的房间记录没有丢失，请稍后再试。";
    }
  }
  const message = error instanceof Error ? error.message : "";
  if (/audience|受众/i.test(message)) {
    return "这项内容只给部分人看，不能放到可见范围更大的画面上，以免泄露给其他玩家。";
  }
  if (/revision|conflict|版本冲突/i.test(message)) {
    return "另一位成员刚刚更新了这里。等画面刷新后，再试一次。";
  }
  const reducerExplanation = friendlyHostReducerError(message);
  if (reducerExplanation) return reducerExplanation;
  if (/^(请先|当前画面|当前没有|地点“|人物“|线索“|拖入的场景|房主当前离线|席位认证)/.test(message)) {
    return message;
  }
  // The host applies commands to its own authoritative reducer, so its
  // failures surface as raw errors instead of classified rejections. An
  // unrecognized reason must still be shown — hiding it behind a generic
  // apology leaves the Keeper unable to understand what happened.
  if (message.trim()) return `刚才的操作没有完成：${message.trim()}`;
  return "刚才的操作没有完成，请稍后再试。";
}

/**
 * The host commits commands to the local reducer directly, so protocol guard
 * failures reach it as raw English `Error`s (see packages/protocol
 * room-world-v2.ts / event-log-v2.ts) rather than the classified
 * RoomCommandRejectedError players receive. Translate the known guards into
 * the same friendly copy.
 */
function friendlyHostReducerError(message: string): string | undefined {
  if (/^check request .+ does not exist$/i.test(message) || /^check .+ was (already )?closed$/i.test(message)) {
    return "这项行动刚刚被撤回或已经结束，不需要再处理它。";
  }
  if (/^check .+ was already authorized$/i.test(message)) {
    return "这项行动刚刚已经有了裁定，不能重复裁定。";
  }
  if (/^check .+ was already rolled$/i.test(message)) {
    return "这次检定已经掷过骰了，以先掷出的结果为准。";
  }
  if (/^check .+ was not authorized$/i.test(message)) {
    return "这次检定还没有得到 KP 允许，等 KP 裁定后再掷骰。";
  }
  if (/^duplicate check request /i.test(message)) {
    return "这项行动已经提交过了，等待 KP 处理即可。";
  }
  if (/^a failed check may only be pushed once$/i.test(message)) {
    return "失败的检定只能强推一次，这次机会已经用掉了。";
  }
  if (/^check .+ outcome was already described$/i.test(message)) {
    return "这次检定的结果已经描述过了，不能再描述一次。";
  }
  if (/^check .+ outcome requires a completed roll$/i.test(message)) {
    return "调查员还没有掷骰，先等骰子落定再描述结果。";
  }
  if (/(does not match .* authorization|result does not match its authorization)/i.test(message)) {
    return "这次掷骰与 KP 允许的检定参数不一致。等画面刷新后，再试一次。";
  }
  if (/^Board .+ is archived$/i.test(message)) {
    return "这个画面已经被收起了，先重新打开或换一个画面。";
  }
  if (/^Board .+ is not visible/i.test(message)) {
    return "这个画面只给部分人看，你现在不能改动它。";
  }
  if (/^character .+ is already referenced by an unowned token/i.test(message)) {
    return "这张角色卡的棋子还没有确定归属，请让 KP 先确认棋子归属。";
  }
  if (/^(only the host may|players may|a player cannot)/i.test(message)) {
    return "你现在不能执行这个操作。内容可能只给部分人看，或已被 KP 设为只读。";
  }
  return undefined;
}

/** Human label for the authorized bonus/penalty dice, if any apply. */
function bonusPenaltyLabelV2({ bonusDice, penaltyDice }: {
  readonly bonusDice: number;
  readonly penaltyDice: number;
}): string | undefined {
  if (bonusDice > 0) return `${bonusDice} 个奖励骰`;
  if (penaltyDice > 0) return `${penaltyDice} 个惩罚骰`;
  return undefined;
}

function characterCheckOptions(character: Coc7Character): Array<{ id: string; name: string; value: number }> {
  const characteristics: Array<{ key: keyof Coc7Character["characteristics"]; name: string }> = [
    { key: "str", name: "力量" },
    { key: "con", name: "体质" },
    { key: "siz", name: "体型" },
    { key: "dex", name: "敏捷" },
    { key: "app", name: "外貌" },
    { key: "int", name: "智力" },
    { key: "pow", name: "意志" },
    { key: "edu", name: "教育" },
    { key: "luck", name: "幸运" },
  ];
  return [
    ...character.skills.map((skill) => ({ id: `skill:${skill.id}`, name: skill.name, value: skill.value })),
    ...characteristics.map(({ key, name }) => ({ id: `characteristic:${key}`, name, value: character.characteristics[key] })),
  ];
}

function hasLiveOrConsumedPushV2(world: RoomWorldStateV2, originalRequestId: string): boolean {
  return [...world.checkRequests.values()]
    .filter(({ pushOfRequestId }) => pushOfRequestId === originalRequestId)
    .some(({ requestId }) => {
      // Once KP has stated a consequence and authorized the push, the player
      // has received the one informed choice allowed by the rules. Declining
      // that authorized roll still consumes it. A pre-authorization rejection
      // or withdrawal only rejects that proposed method, so another genuinely
      // different approach remains possible.
      if (world.checkAuthorizations.has(requestId)) return true;
      const closure = world.checkClosures.get(requestId);
      return closure === undefined || closure.outcome === "no-roll";
    });
}
