import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Check, Clapperboard, Copy, Dices, Download, FileText, FolderKanban, ImagePlus, Loader2, LogOut, Map, MoreHorizontal, Music, Plus, RefreshCw, Send, Sparkles, Square, UserRound, UsersRound, Volume2, VolumeX, Wrench, X } from "lucide-react";
import {
  exportEventsV2ToHtml,
  exportEventsV2ToMarkdown,
  isAudienceSubsetV2,
  parseDiceExpression,
  type AssetDescriptorV1,
  type AudienceV2,
  type BoardEdgeV1,
  type BoardItemV1,
  type BoardPointV1,
  type BoardV1,
  type CheckAuthorizationV2,
  type CheckRequestV2,
  type ModulePackageV1,
  type NpcInteractionSessionV1,
  type RoomArtifactV2,
  type RoomEntityV2,
  type RoomEventV2,
  type RoomEventViewV2,
  type RoomWorldStateV2,
  type SeatV2,
} from "@coc-room/protocol";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { getRepository, type RoomRecord } from "../data/repository";
import { encodeInvitationV2 } from "../lib/invitation";
import { downloadTextInBrowser } from "../lib/browser-download";
import { storedCocmodContents } from "../lib/cocmod-package";
import {
  hasPublishedEntityImageV2,
  isImageBearingEntityV2,
  publishEntityImageV2,
} from "../lib/entity-image-publication-v2";
import { prepareTranscriptAssetsV2 } from "../lib/transcript-assets-v2";
import {
  addManagedAssetReference,
  hasManagedAssetStore,
  resolveManagedAssetUrl,
  selectAndImportAsset,
} from "../lib/asset-store";
import type { RoomSessionV2, V2AuthenticationState } from "../network/RoomSessionV2";
import type { ConnectionPath } from "../network/RoomTransport";
import {
  ArtifactAttachmentViewerV2,
  ArtifactWorkspaceV2,
  attachEntityPresentationV2,
  BoardBackgroundPublisherV2,
  CheckNegotiationV2,
  CollaborativeBoardCanvas,
  EntityImagePublisherV2,
  handleModuleSceneDropV2,
  KeeperModuleWorkbenchV2,
  ManualScenePresenterV2,
  NpcSessionStartDialogV2,
  npcPanelSpeakerLabelV2,
  npcSessionAudienceLabelV2,
  pendingModuleSceneEntriesV2,
  PublicClueBoardV2,
  VisibleEntityArtifactMediaV2,
} from "../components/room/v2";
import { Button } from "../components/ui/Button";
import { Field, Input, Textarea } from "../components/ui/Field";
import { Panel } from "../components/ui/Panel";
import { SynchronizedAudioRuntime, type AudioSyncStatus } from "../lib/audio-sync";
import {
  codexImageExecutor,
  type CodexImageCapabilities,
  type CodexImageDraft,
  type CodexImageJobKind,
} from "../lib/codex-image-executor";
import type { NpcInteractionJobStatusV1, NpcShadowReplyV1 } from "../ai/npc-interaction-broker";
import { useAppStore } from "../store/app-store";
import {
  tauriNpcStatsDraftExecutor,
  type NpcStatsDraftV1,
  type NpcStatsProvider,
} from "../ai/tauri-npc-stats-draft-executor";

export interface RoomViewV2Props {
  room: RoomRecord;
  session?: RoomSessionV2;
  views: RoomEventViewV2[];
  world: RoomWorldStateV2;
  seats: SeatV2[];
  paths: Record<string, ConnectionPath>;
  authenticationState: V2AuthenticationState;
  readOnly?: boolean;
  connectionError?: string;
  setConnectionError(message?: string): void;
  resolveAsset?(asset: AssetDescriptorV1): Promise<string>;
  npcJobStatuses?: NpcInteractionJobStatusV1[];
  npcShadowReplies?: NpcShadowReplyV1[];
  onDismissNpcShadow?(jobId: string): void;
  onLeave(): void;
}

type ExportState =
  | { readonly status: "idle" }
  | { readonly status: "working"; readonly format: "md" | "html" }
  | { readonly status: "success"; readonly message: string }
  | { readonly status: "error"; readonly format: "md" | "html"; readonly detail: string };

type AudioOperation = "idle" | "selecting" | "waiting" | "starting" | "stopping";

type HumanRecordCategory = "all" | "dialogue" | "checks" | "discoveries" | "status";

const HUMAN_RECORD_CATEGORIES: ReadonlyArray<{ readonly id: HumanRecordCategory; readonly label: string }> = [
  { id: "all", label: "全部" },
  { id: "dialogue", label: "对话" },
  { id: "checks", label: "检定" },
  { id: "discoveries", label: "发现" },
  { id: "status", label: "角色与状态" },
];

export function RoomViewV2({
  room,
  session,
  views,
  world,
  seats,
  paths,
  authenticationState,
  readOnly = false,
  connectionError,
  setConnectionError,
  resolveAsset,
  npcJobStatuses = [],
  npcShadowReplies = [],
  onDismissNpcShadow,
  onLeave,
}: RoomViewV2Props) {
  const setActiveView = useAppStore((state) => state.setActiveView);
  const [activeRoomTab, setActiveRoomTab] = useState<"scene" | "clues" | "record">("scene");
  // Keep the original storage key so existing players do not see old clues as
  // new again. It now covers every public case-file item, not just clues.
  const caseFileSeenStorageKey = `coc-room:v2:seen-public-clue:${room.id}:${session?.localSeat.seatId ?? room.localSeatId ?? room.localPeerId}`;
  const [seenPublicMaterialSequence, setSeenPublicMaterialSequence] = useState(() => readSeenPublicMaterialSequence(caseFileSeenStorageKey));
  const [recordCategory, setRecordCategory] = useState<HumanRecordCategory>("all");
  const [recordQuery, setRecordQuery] = useState("");
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const [exportState, setExportState] = useState<ExportState>({ status: "idle" });
  const mobileToolsPanelRef = useRef<HTMLElement>(null);
  const mobileToolsCloseRef = useRef<HTMLButtonElement>(null);
  const npcConversationDetailsRef = useRef<HTMLDetailsElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const currentActionSectionRef = useRef<HTMLElement>(null);
  const activeBoardSectionRef = useRef<HTMLElement>(null);
  const [dismissedCluePromptForEventId, setDismissedCluePromptForEventId] = useState<string>();
  const [acknowledgedPlayerClosureEventId, setAcknowledgedPlayerClosureEventId] = useState<string>();
  const [boardExpanded, setBoardExpanded] = useState(false);
  const [selectedBoardItemId, setSelectedBoardItemId] = useState<string>();
  const [caseFileBoardId, setCaseFileBoardId] = useState<string>();
  const [message, setMessage] = useState("");
  const [checkOutcomeText, setCheckOutcomeText] = useState("");
  const [dice, setDice] = useState("1d100");
  const [reason, setReason] = useState("");
  const [newSeatName, setNewSeatName] = useState("");
  const [latestInvitation, setLatestInvitation] = useState<string>();
  const [invitationCopied, setInvitationCopied] = useState(false);
  const [entityName, setEntityName] = useState("");
  const [entityDescription, setEntityDescription] = useState("");
  const [entityKind, setEntityKind] = useState<"location" | "npc" | "clue">("clue");
  const [presentNewEntityInActiveScene, setPresentNewEntityInActiveScene] = useState(true);
  const [newBoardKind, setNewBoardKind] = useState<"scene" | "map">("scene");
  const [newBoardName, setNewBoardName] = useState("");
  const [secretDraft, setSecretDraft] = useState(false);
  const [npcMessage, setNpcMessage] = useState("");
  const [activeNpcSessionId, setActiveNpcSessionId] = useState<string>();
  const [pendingNpcSessionEntityId, setPendingNpcSessionEntityId] = useState<string>();
  const [npcSessionCreating, setNpcSessionCreating] = useState(false);
  const [npcPinTitle, setNpcPinTitle] = useState("");
  const [npcPinBody, setNpcPinBody] = useState("");
  const [preparedAudio, setPreparedAudio] = useState<AssetDescriptorV1>();
  const [audioTitle, setAudioTitle] = useState("氛围音乐");
  const [audioOperation, setAudioOperation] = useState<AudioOperation>("idle");
  const audioCueAttemptRef = useRef(0);
  const [audioLoop, setAudioLoop] = useState(true);
  const [audioVolume, setAudioVolume] = useState(0.7);
  const [audioFadeInMs, setAudioFadeInMs] = useState(1_000);
  const [audioFadeOutMs, setAudioFadeOutMs] = useState(1_000);
  const [audioStartOffsetMs, setAudioStartOffsetMs] = useState(0);
  const [localAudioVolume, setLocalAudioVolume] = useState(1);
  const [audioMuted, setAudioMuted] = useState(false);
  const [audioStatus, setAudioStatus] = useState<AudioSyncStatus>();
  const [imageCapabilities, setImageCapabilities] = useState<CodexImageCapabilities>();
  const [imageKind, setImageKind] = useState<CodexImageJobKind>("location");
  const [imageDescription, setImageDescription] = useState("");
  const [imageStyle, setImageStyle] = useState("");
  const [imageTarget, setImageTarget] = useState("");
  const [localImageEntityId, setLocalImageEntityId] = useState("");
  const [imageDraft, setImageDraft] = useState<CodexImageDraft>();
  const [imageBusy, setImageBusy] = useState(false);
  const [npcStatsTargetId, setNpcStatsTargetId] = useState("");
  const [npcStatsProvider, setNpcStatsProvider] = useState<NpcStatsProvider>("codex");
  const [npcStatsModel, setNpcStatsModel] = useState("");
  const [npcStatsGuidance, setNpcStatsGuidance] = useState("");
  const [npcStatsDraft, setNpcStatsDraft] = useState<{
    draft: NpcStatsDraftV1;
    sourceRevision: number;
  }>();
  const [npcStatsBusy, setNpcStatsBusy] = useState(false);
  const [activeModulePackage, setActiveModulePackage] = useState<ModulePackageV1>();
  const [activeModuleLoading, setActiveModuleLoading] = useState(false);
  const [activeModuleLoadError, setActiveModuleLoadError] = useState<string>();
  const [activeModuleLoadAttempt, setActiveModuleLoadAttempt] = useState(0);
  const activeModuleHasScenes = Boolean(activeModulePackage && activeModulePackage.scenes.length > 0);
  const activeModuleHasNoScenes = Boolean(activeModulePackage && activeModulePackage.scenes.length === 0);
  const activeModuleImageAssets = useMemo(() => moduleImageAssets(activeModulePackage), [activeModulePackage]);
  const activeBoardCandidate = world.activeBoardId
    ? world.boards.get(world.activeBoardId)
    : undefined;
  const board = activeBoardCandidate
    && !activeBoardCandidate.archived
    && activeBoardCandidate.kind !== "evidence"
      ? activeBoardCandidate
      : undefined;
  const liveBoards = [...world.boards.values()].filter((candidate) => candidate.kind !== "evidence" && !candidate.archived);
  const evidenceBoards = [...world.boards.values()].filter((candidate) => candidate.kind === "evidence" && !candidate.archived);
  const caseFileBoard = evidenceBoards.find(({ boardId }) => boardId === caseFileBoardId) ?? evidenceBoards[0];
  const selectedBoardItem = board?.items.find(({ itemId }) => itemId === selectedBoardItemId);
  const playerMovableMapItems = session && !session.isHost && board?.kind === "map"
    ? board.items.filter((item) => canSeatMoveBoardItem(world, board, item, session))
    : [];
  const activeSceneCandidate = world.activeSceneEntityId
    ? world.entities.get(world.activeSceneEntityId)
    : undefined;
  const activeScene = activeSceneCandidate?.kind === "scene" ? activeSceneCandidate : undefined;
  const activeScenePresentations = activeScene
    ? [...world.entities.values()].filter((entity) => entity.entityId !== activeScene.entityId && entityPresentedInScene(entity, activeScene.entityId))
    : [];
  const activeSceneLocations = activeScenePresentations.filter(({ kind }) => kind === "location");
  const activeSceneNpcs = activeScenePresentations.filter(({ kind }) => kind === "npc");
  const pendingModuleSceneEntries = useMemo(
    () => activeModulePackage
      ? pendingModuleSceneEntriesV2(world, activeModulePackage, board)
      : [],
    [activeModulePackage, board, world],
  );
  const backgroundArtifact = board?.backgroundArtifactId
    ? world.artifacts.get(board.backgroundArtifactId)
    : undefined;
  const backgroundAsset = backgroundArtifact?.asset ?? backgroundArtifact?.attachments[0];
  const backgroundResolution = useManagedAssetUrl(backgroundAsset, resolveAsset);
  const caseFileBackgroundArtifact = caseFileBoard?.backgroundArtifactId
    ? world.artifacts.get(caseFileBoard.backgroundArtifactId)
    : undefined;
  const caseFileBackgroundAsset = caseFileBackgroundArtifact?.asset ?? caseFileBackgroundArtifact?.attachments[0];
  const caseFileBackgroundResolution = useManagedAssetUrl(caseFileBackgroundAsset, resolveAsset);
  const imageDraftUrl = useManagedAssetUrl(imageDraft?.asset).url;
  const imageKeeperAuthorization = useMemo(() => {
    if (
      !session?.isHost
      || room.protocolVersion !== 2
      || !room.localSeatId
      || room.localSeatId !== room.hostSeatId
    ) return undefined;
    return { roomId: room.id, seatId: room.localSeatId };
  }, [room.hostSeatId, room.id, room.localSeatId, room.protocolVersion, session?.isHost]);
  const imageTargetOptions = useMemo(() => roomImageTargetOptions(imageKind, world), [imageKind, world]);
  const localImageEntities = useMemo(
    () => [...world.entities.values()].filter(isImageBearingEntityV2),
    [world.entities],
  );
  const localImageEntity = localImageEntityId
    ? world.entities.get(localImageEntityId)
    : undefined;
  const selectedImageTargetLabel = imageTargetOptions.find(({ value }) => value === imageTarget)?.label;
  const commandsDisabled = readOnly || !session || (!session.isHost && authenticationState !== "authenticated");
  const visibleEvents = useMemo(
    () => views.filter((view): view is Extract<RoomEventViewV2, { view: "full" }> => view.view === "full"),
    [views],
  );
  const humanRecordEvents = useMemo(
    () => visibleEvents.map(({ event }) => event).filter(isHumanRecordEvent),
    [visibleEvents],
  );
  const filteredRecordEvents = useMemo(() => humanRecordEvents.filter((event) =>
    (recordCategory === "all" || humanRecordCategory(event) === recordCategory)
    && matchesHumanRecordQuery(event, recordQuery, world),
  ), [humanRecordEvents, recordCategory, recordQuery, world]);
  const recordFiltersActive = recordCategory !== "all" || recordQuery.trim().length > 0;
  const liveStoryEvents = useMemo(
    () => humanRecordEvents.filter(isLiveStoryEvent).slice(-12),
    [humanRecordEvents],
  );
  const pendingCheckRequests = [...world.checkRequests.values()].filter(({ requestId }) =>
    !world.checkAuthorizations.has(requestId) && !world.checkClosures.has(requestId),
  );
  const ownReadyChecks = [...world.checkAuthorizations.values()].filter(({ requestId, requesterSeatId, resolvedByEventId }) =>
    requesterSeatId === session?.localSeat.seatId
      && resolvedByEventId === undefined
      && !world.checkClosures.has(requestId),
  );
  const primaryOwnReadyCheck = ownReadyChecks.find(({ requestId }) =>
    world.checkRequests.get(requestId)?.pushOfRequestId !== undefined,
  ) ?? ownReadyChecks[0];
  const primaryOwnReadyRequest = primaryOwnReadyCheck
    ? world.checkRequests.get(primaryOwnReadyCheck.requestId)
    : undefined;
  const latestOwnKeeperClosureEvent = [...humanRecordEvents].reverse().find(
    (event): event is Extract<RoomEventV2, { type: "check.closed" }> => {
      if (
        event.type !== "check.closed"
        || event.sender.role !== "host"
        || (event.payload.outcome !== "no-roll" && event.payload.outcome !== "declined")
      ) return false;
      return world.checkRequests.get(event.payload.requestId)?.requesterSeatId === session?.localSeat.seatId;
    },
  );
  const hasOwnCheckActivityAfterClosure = latestOwnKeeperClosureEvent
    ? humanRecordEvents.some((event) => {
        if (event.sequence <= latestOwnKeeperClosureEvent.sequence) return false;
        if (event.type === "check.requested") return event.sender.seatId === session?.localSeat.seatId;
        if (event.type !== "dice.result" || !event.payload.checkRequestId) return false;
        return world.checkRequests.get(event.payload.checkRequestId)?.requesterSeatId === session?.localSeat.seatId;
      })
    : false;
  const playerClosureHandoff = latestOwnKeeperClosureEvent
    && !hasOwnCheckActivityAfterClosure
    && acknowledgedPlayerClosureEventId !== latestOwnKeeperClosureEvent.eventId
      ? latestOwnKeeperClosureEvent
      : undefined;
  const publicCaseFileEvents = useMemo(() => humanRecordEvents.filter((event) =>
    event.type === "artifact.upserted"
      && isCaseFileArtifactKind(event.payload.artifact.kind)
      && event.payload.artifact.audience.kind === "room",
  ), [humanRecordEvents]);
  const latestPublicCaseFileEvent = [...publicCaseFileEvents].reverse().find((event) =>
    event.type === "artifact.upserted"
      && world.artifacts.get(event.payload.artifact.artifactId)?.archived === false,
  );
  const unseenPublicCaseFileEvents = publicCaseFileEvents.filter((event) =>
    event.type === "artifact.upserted"
      && event.sequence > seenPublicMaterialSequence
      && world.artifacts.get(event.payload.artifact.artifactId)?.archived === false
  );
  const unseenPublicMaterialCount = new Set(unseenPublicCaseFileEvents.map((event) =>
    event.type === "artifact.upserted" ? event.payload.artifact.artifactId : "",
  )).size;
  const unseenPublicMaterialIncludesSupportingMaterial = unseenPublicCaseFileEvents.some((event) =>
    event.type === "artifact.upserted" && event.payload.artifact.kind !== "clue",
  );
  const latestUnresolvedCheckRoll = [...humanRecordEvents].reverse().find((event) =>
    event.type === "dice.result"
      && event.payload.checkRequestId !== undefined
      && !world.checkOutcomes.has(event.payload.checkRequestId),
  );
  const latestUnresolvedCheckRequest = latestUnresolvedCheckRoll?.type === "dice.result" && latestUnresolvedCheckRoll.payload.checkRequestId
    ? world.checkRequests.get(latestUnresolvedCheckRoll.payload.checkRequestId)
    : undefined;
  const latestUnresolvedCheckSucceeded = latestUnresolvedCheckRoll?.type === "dice.result"
    && latestUnresolvedCheckRoll.payload.result.kind === "percentile"
    ? latestUnresolvedCheckRoll.payload.result.check?.success
    : undefined;
  const latestUnresolvedCheckWasPushed = latestUnresolvedCheckRequest?.pushOfRequestId !== undefined;
  const latestOwnCheckRoll = !session?.isHost
    ? [...humanRecordEvents].reverse().find((event) => {
        if (event.type !== "dice.result" || !event.payload.checkRequestId) return false;
        return world.checkRequests.get(event.payload.checkRequestId)?.requesterSeatId === session?.localSeat.seatId;
      })
    : undefined;
  const latestOwnCheckRequest = latestOwnCheckRoll?.type === "dice.result" && latestOwnCheckRoll.payload.checkRequestId
    ? world.checkRequests.get(latestOwnCheckRoll.payload.checkRequestId)
    : undefined;
  const playerWaitingForKeeperOutcome = Boolean(
    latestOwnCheckRoll
      && latestOwnCheckRequest
      && !world.checkOutcomes.has(latestOwnCheckRequest.requestId),
  );
  const latestCheckOutcomeEvent = [...humanRecordEvents].reverse().find(
    (event): event is Extract<RoomEventV2, { type: "check.outcome.described" }> => event.type === "check.outcome.described",
  );
  const eventsAfterLatestOutcome = latestCheckOutcomeEvent
    ? humanRecordEvents.filter((event) => event.sequence > latestCheckOutcomeEvent.sequence)
    : [];
  const cluePublishedAfterLatestOutcome = eventsAfterLatestOutcome.some((event) =>
    event.type === "artifact.upserted" && event.payload.artifact.kind === "clue",
  );
  const movedToAnotherSceneAfterLatestOutcome = eventsAfterLatestOutcome.some((event) => event.type === "scene.focused");
  const followupCheckAfterLatestOutcome = eventsAfterLatestOutcome.some((event) => event.type === "check.requested");
  const keeperNeedsToDescribeOutcome = Boolean(
    session?.isHost
      && latestUnresolvedCheckRoll
      && latestUnresolvedCheckRequest,
  );
  const keeperNeedsToDecideClue = Boolean(
    session?.isHost
    && latestCheckOutcomeEvent
    && !cluePublishedAfterLatestOutcome
    && !movedToAnotherSceneAfterLatestOutcome
    && !followupCheckAfterLatestOutcome
    && dismissedCluePromptForEventId !== latestCheckOutcomeEvent.eventId,
  );
  const roomActionCount = session?.isHost
    ? pendingCheckRequests.length
      + (keeperNeedsToDescribeOutcome ? 1 : 0)
      + pendingModuleSceneEntries.length
    : ownReadyChecks.length + (playerClosureHandoff ? 1 : 0);
  const ownRoomCharacters = session
    ? [...world.latestCharacters.values()].filter(({ ownerPeerId }) => ownerPeerId === session.localSeat.seatId)
    : [];
  const playerSeats = seats.filter(({ role }) => role === "player");
  const showFirstInvitationCard = Boolean(
    !readOnly
      && session?.isHost
      && !invitationCopied
      && (playerSeats.length === 0 || (latestInvitation && playerSeats.length === 1)),
  );
  const npcSessionsNewestFirst = [...world.npcSessions.values()].reverse();
  const activeNpcSession = (activeNpcSessionId ? world.npcSessions.get(activeNpcSessionId) : undefined)
    ?? npcSessionsNewestFirst.find(({ status }) => status === "active")
    ?? npcSessionsNewestFirst[0];
  const activeNpcEntity = activeNpcSession
    ? world.entities.get(activeNpcSession.npcEntityId)
    : undefined;
  const pendingNpcSessionEntity = pendingNpcSessionEntityId
    ? world.entities.get(pendingNpcSessionEntityId)
    : undefined;
  const activeNpcStatuses = activeNpcSession
    ? npcJobStatuses.filter(({ sessionId }) => sessionId === activeNpcSession.sessionId)
    : [];

  useEffect(() => {
    setSeenPublicMaterialSequence(readSeenPublicMaterialSequence(caseFileSeenStorageKey));
  }, [caseFileSeenStorageKey]);

  useEffect(() => {
    setAcknowledgedPlayerClosureEventId(undefined);
  }, [room.id, session?.localSeat.seatId]);

  useEffect(() => {
    setCheckOutcomeText("");
  }, [latestUnresolvedCheckRequest?.requestId]);

  useEffect(() => {
    if (activeRoomTab !== "clues" || !latestPublicCaseFileEvent) return;
    const sequence = latestPublicCaseFileEvent.sequence;
    setSeenPublicMaterialSequence((current) => Math.max(current, sequence));
    writeSeenPublicMaterialSequence(caseFileSeenStorageKey, sequence);
  }, [activeRoomTab, caseFileSeenStorageKey, latestPublicCaseFileEvent]);

  useEffect(() => {
    if (!mobileToolsOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const focusFrame = window.requestAnimationFrame(() => mobileToolsCloseRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileToolsOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const panel = mobileToolsPanelRef.current;
      if (!panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      )].filter((element) => {
        const closedDetails = element.closest("details:not([open])");
        return !closedDetails || (element.tagName === "SUMMARY" && closedDetails.firstElementChild === element);
      });
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [mobileToolsOpen]);
  const activeNpcShadowReplies = activeNpcSession
    ? npcShadowReplies.filter(({ sessionId }) => sessionId === activeNpcSession.sessionId)
    : [];
  const npcAutomationNotices = [...world.npcSessions.values()].flatMap((npcSession) => {
    const latestStatus = npcJobStatuses.filter(({ sessionId }) => sessionId === npcSession.sessionId).at(-1);
    const pendingShadows = npcShadowReplies.filter(({ sessionId }) => sessionId === npcSession.sessionId);
    const assistantActive = npcSession.status === "active" && npcSession.autoReply;
    const needsAttention = latestStatus?.status === "queued"
      || latestStatus?.status === "running"
      || latestStatus?.status === "failed";
    return assistantActive || pendingShadows.length > 0 || needsAttention
      ? [{ npcSession, latestStatus, pendingShadows }]
      : [];
  });
  const availableAudioAssets = [...world.artifacts.values()]
    .filter((artifact) => artifact.kind === "ambience-audio")
    .flatMap((artifact) => [...artifact.attachments, ...(artifact.asset ? [artifact.asset] : [])])
    .filter((asset) => asset.mediaType.startsWith("audio/"));
  const selectedAudio = preparedAudio ?? availableAudioAssets.at(-1);
  const selectedAudioArtifact = selectedAudio
    ? [...world.artifacts.values()].reverse().find((artifact) => [...artifact.attachments, ...(artifact.asset ? [artifact.asset] : [])].some(({ assetId }) => assetId === selectedAudio.assetId))
    : undefined;
  const selectedAudioTitle = preparedAudio
    ? audioTitle.trim() || "氛围音乐"
    : selectedAudioArtifact?.title ?? "氛围音乐";
  const audioRuntime = useMemo(() => new SynchronizedAudioRuntime({
    resolveAssetUrl: async (asset) => {
      if (resolveAsset) return resolveAsset(asset);
      if (!hasManagedAssetStore()) return null;
      return resolveManagedAssetUrl(asset.assetId);
    },
    localVolume: localAudioVolume,
    muted: audioMuted,
    onStatus: setAudioStatus,
  }), [resolveAsset]);

  useEffect(() => () => audioRuntime.dispose(), [audioRuntime]);
  useEffect(() => {
    audioRuntime.setLocalVolume(localAudioVolume);
    audioRuntime.setMuted(audioMuted);
  }, [audioMuted, audioRuntime, localAudioVolume]);
  useEffect(() => {
    for (const view of views) audioRuntime.consumeView(view);
  }, [audioRuntime, views]);
  useEffect(() => {
    if (!resolveAsset) return;
    for (const artifact of world.artifacts.values()) {
      for (const asset of [...artifact.attachments, ...(artifact.asset ? [artifact.asset] : [])]) {
        if (asset.mediaType.startsWith("image/") || asset.mediaType.startsWith("audio/")) {
          void resolveAsset(asset).catch(() => undefined);
        }
      }
    }
  }, [authenticationState, resolveAsset, world.artifacts]);
  useEffect(() => {
    if (!imageKeeperAuthorization || readOnly || !hasManagedAssetStore()) return;
    let active = true;
    void codexImageExecutor.capabilities(imageKeeperAuthorization)
      .then((capabilities) => { if (active) setImageCapabilities(capabilities); })
      .catch((error) => {
        if (!active) return;
        setImageCapabilities({
          installed: false,
          compatible: false,
          authenticated: false,
          imageGeneration: false,
          message: imageCapabilityMessage(error),
        });
      });
    return () => { active = false; };
  }, [imageKeeperAuthorization, readOnly, setConnectionError]);
  useEffect(() => {
    let cancelled = false;
    setActiveModulePackage(undefined);
    setActiveModuleLoadError(undefined);
    if (readOnly || !session?.isHost || !world.activeModule) {
      setActiveModuleLoading(false);
      return () => { cancelled = true; };
    }
    setActiveModuleLoading(true);
    void getRepository()
      .then((repository) => repository.getModule(world.activeModule!.moduleId, world.activeModule!.revision))
      .then((stored) => {
        if (cancelled) return;
        if (!stored) {
          setActiveModuleLoadError(`本机找不到《${world.activeModule!.title}》正在使用的版本。`);
          return;
        }
        setActiveModulePackage(stored.package);
      })
      .catch((error) => {
        if (!cancelled) setActiveModuleLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setActiveModuleLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeModuleLoadAttempt, readOnly, session?.isHost, world.activeModule?.moduleId, world.activeModule?.revision]);

  const run = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
      setConnectionError(undefined);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    }
  };

  const revealNpcConversation = (sessionId: string) => {
    setActiveNpcSessionId(sessionId);
    const isMobile = typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 1023px)").matches
      : window.innerWidth < 1024;
    if (isMobile) setMobileToolsOpen(true);
    globalThis.setTimeout(() => {
      const details = npcConversationDetailsRef.current;
      if (!details) return;
      details.open = true;
      details.scrollIntoView?.({ block: "start" });
      details.querySelector<HTMLElement>("summary")?.focus();
    }, 0);
  };

  const sendChat = () => run(async () => {
    const value = message.trim();
    if (!value || !session) return;
    await session.submit({
      type: "chat.message",
      audience: { kind: "room" },
      payload: { message: value, format: "plain" },
    });
    setMessage("");
  });

  const roll = () => run(async () => {
    if (!session) return;
    const parsed = parseDiceExpression(dice);
    await session.rollDice({
      expression: parsed.normalized,
      reason: reason.trim(),
      bonusDice: 0,
      penaltyDice: 0,
    });
  });

  const createBoard = () => run(async () => {
    if (!session?.isHost) return;
    const boardId = globalThis.crypto.randomUUID();
    await session.submit({
      type: "board.created",
      audience: { kind: "room" },
      payload: {
        board: {
          schemaVersion: 1,
          boardId,
          revision: 1,
          kind: newBoardKind,
          name: newBoardName.trim() || defaultBoardName(newBoardKind),
          description: "",
          audience: { kind: "room" },
          logicalSize: { width: 1600, height: 900 },
          archived: false,
          items: [],
          edges: [],
          extensions: {},
        },
      },
    });
    await session.submit({
      type: "board.activated",
      audience: { kind: "room" },
      payload: { boardId },
    });
    setNewBoardName("");
    setBoardExpanded(true);
  });

  const createCaseFileBoard = () => run(async () => {
    if (!session?.isHost) return;
    const boardId = globalThis.crypto.randomUUID();
    await session.submit({
      type: "board.created",
      audience: { kind: "room" },
      payload: {
        board: {
          schemaVersion: 1,
          boardId,
          revision: 1,
          kind: "evidence",
          name: "共同推理板",
          description: "把公开线索放在这里，并用关系线整理大家的推测。",
          audience: { kind: "room" },
          logicalSize: { width: 1600, height: 900 },
          archived: false,
          items: [],
          edges: [],
          extensions: {},
        },
      },
    });
    setCaseFileBoardId(boardId);
  });

  const activateBoard = (boardId: string) => run(async () => {
    if (!session?.isHost) return;
    const target = world.boards.get(boardId);
    if (!target || target.archived || target.kind === "evidence") return;
    await session.submit({ type: "board.activated", audience: target.audience, payload: { boardId } });
  });

  const archiveBoard = (target: BoardV1) => run(async () => {
    if (!session?.isHost || target.archived) return;
    await session.submit({
      type: "board.updated",
      audience: target.audience,
      payload: { board: { ...target, revision: target.revision + 1, archived: true } },
    });
  });

  const publishBoardBackground = async (asset: AssetDescriptorV1) => {
    if (!session?.isHost || !board) throw new Error("当前画面已经不可编辑，请重新打开后再试。");
    const artifactId = globalThis.crypto.randomUUID();
    await addManagedAssetReference({
      assetId: asset.assetId,
      ownerType: "artifact",
      ownerId: artifactId,
      ownerRevision: 1,
      slot: "board.background",
    });
    await session.submit({
      type: "artifact.upserted",
      audience: board.audience,
      payload: {
        artifact: {
          schemaVersion: 2,
          artifactId,
          revision: 1,
          kind: board.kind === "map" ? "map-background" : "location-background",
          title: `${board.name}背景`,
          description: "由房主确认公开的场景背景",
          body: "",
          attachments: [],
          asset,
          audience: board.audience,
          locked: true,
          archived: false,
          extensions: {},
        },
      },
    });
    await session.submit({
      type: "board.updated",
      audience: board.audience,
      payload: { board: { ...board, revision: board.revision + 1, backgroundArtifactId: artifactId } },
    });
  };

  const enableFog = () => run(async () => {
    if (!session?.isHost || !board || board.fogMask) return;
    await session.submit({
      type: "board.updated",
      audience: board.audience,
      payload: {
        board: {
          ...board,
          revision: board.revision + 1,
          fogMask: {
            schemaVersion: 1,
            maskId: globalThis.crypto.randomUUID(),
            revision: 1,
            mode: "cover-all",
            audience: board.audience,
            revealedRegions: [],
            extensions: {},
          },
        },
      },
    });
  });

  const createEntity = () => run(async () => {
    if (!session || !entityName.trim()) return;
    if (!session.isHost && entityKind !== "clue") {
      throw new Error("玩家可以新建线索；地点和人物由 KP 公开。");
    }
    const audience = draftAudience(secretDraft, session.localSeat);
    const name = entityName.trim();
    const description = entityDescription.trim();
    if (entityKind === "clue") {
      if (!description) throw new Error("线索需要填写玩家可见正文。");
      const artifact: RoomArtifactV2 = {
        schemaVersion: 2,
        artifactId: globalThis.crypto.randomUUID(),
        revision: 1,
        kind: "clue",
        title: name,
        description: "",
        body: description,
        attachments: [],
        audience,
        locked: false,
        archived: false,
        extensions: {},
      };
      await session.submitConfirmed({
        type: "artifact.upserted",
        audience,
        payload: { artifact },
      });
      setActiveRoomTab("clues");
    } else {
      const presentedSceneId = activeScene && presentNewEntityInActiveScene
        ? activeScene.entityId
        : undefined;
      const entity: RoomEntityV2 = {
        schemaVersion: 2,
        entityId: globalThis.crypto.randomUUID(),
        revision: 1,
        kind: entityKind,
        name,
        description,
        artifactIds: [],
        audience,
        data: presentedSceneId ? { presentedInSceneEntityIds: [presentedSceneId] } : {},
        extensions: {},
      };
      await session.submitConfirmed({
        type: "entity.upserted",
        audience,
        payload: { entity },
      });
      if (presentedSceneId) setActiveRoomTab("scene");
    }
    setEntityName("");
    setEntityDescription("");
    setMobileToolsOpen(false);
  });

  const presentEntityInActiveScene = (entity: RoomEntityV2) => run(async () => {
    if (!session?.isHost || !activeScene || (entity.kind !== "location" && entity.kind !== "npc")) return;
    await attachEntityPresentationV2(session, entity, activeScene.entityId);
    setActiveRoomTab("scene");
    setMobileToolsOpen(false);
  });

  const placeEntity = (entity: RoomEntityV2) => run(async () => {
    if (!session || !board) return;
    if (!session.isHost && !(board.kind === "evidence" && entity.kind === "clue")) {
      throw new Error("调查员只能在共享推理板摆放线索；场景与地图内容由 KP 发布。");
    }
    if (!isAudienceSubsetV2(board.audience, entity.audience)) {
      throw new Error("这项内容只给部分人看，不能放进所有人都能看到的画面。请先由 KP 调整可见范围。");
    }
    const item: BoardItemV1 = {
      schemaVersion: 1,
      itemId: globalThis.crypto.randomUUID(),
      reference: { kind: "entity", entityId: entity.entityId },
      label: entity.name,
      position: {
        x: 250 + (board.items.length * 137) % Math.max(300, board.logicalSize.width - 500),
        y: 200 + (board.items.length * 97) % Math.max(250, board.logicalSize.height - 400),
      },
      rotationDegrees: 0,
      scale: 1,
      zIndex: board.items.length,
      locked: false,
      audience: board.audience,
      extensions: {},
    };
    await session.submit({
      type: "board.item.upserted",
      audience: board.audience,
      payload: { boardId: board.boardId, boardRevision: board.revision + 1, item },
    });
  });

  const commitItem = async (item: BoardItemV1) => {
    if (!session || !board) throw new Error("房间连接尚未准备好，棋子位置没有改变");
    if (!canSeatMoveBoardItem(world, board, item, session)) throw new Error("你没有权限移动这个画面项目");
    try {
      await session.submitConfirmed({
        type: "board.item.upserted",
        audience: item.audience,
        payload: { boardId: board.boardId, boardRevision: board.revision + 1, item },
      });
      setConnectionError(undefined);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  const commitSelectedBoardItem = (item: BoardItemV1) => {
    void commitItem(item).catch(() => undefined);
  };

  const removeBoardItem = (item: BoardItemV1) => run(async () => {
    if (!session?.isHost || !board) return;
    await session.submit({
      type: "board.item.removed",
      audience: item.audience,
      payload: { boardId: board.boardId, boardRevision: board.revision + 1, itemId: item.itemId },
    });
    setSelectedBoardItemId(undefined);
  });

  const completeEdge = (fromItemId: string, toItemId: string) => run(async () => {
    if (!session || !board) return;
    if (!session.isHost && board.kind !== "evidence") {
      throw new Error("场景与地图关系由 KP 编辑；调查员可以在线索关系板协作连线。");
    }
    const from = board.items.find((item) => item.itemId === fromItemId);
    const to = board.items.find((item) => item.itemId === toItemId);
    if (!from || !to) return;
    const audience = intersectionAudience(from.audience, to.audience);
    const edge: BoardEdgeV1 = {
      schemaVersion: 1,
      edgeId: globalThis.crypto.randomUUID(),
      fromItemId,
      toItemId,
      kind: "relation",
      label: "",
      audience,
      extensions: {},
    };
    await session.submit({
      type: "board.edge.upserted",
      audience,
      payload: { boardId: board.boardId, boardRevision: board.revision + 1, edge },
    });
  });

  const completeFog = (points: readonly BoardPointV1[]) => run(async () => {
    if (!session?.isHost || !board?.fogMask) return;
    await session.submit({
      type: "board.fog.revealed",
      audience: board.fogMask.audience,
      payload: {
        boardId: board.boardId,
        boardRevision: board.revision + 1,
        maskId: board.fogMask.maskId,
        maskRevision: board.fogMask.revision + 1,
        region: { regionId: globalThis.crypto.randomUUID(), points: [...points] },
      },
    });
  });

  const commitCaseFileItem = async (item: BoardItemV1) => {
    if (!session || !caseFileBoard) throw new Error("房间连接尚未准备好，线索位置没有改变");
    if (!canSeatMoveBoardItem(world, caseFileBoard, item, session)) throw new Error("这个推理板项目已锁定，只有 KP 可以移动");
    try {
      await session.submitConfirmed({
        type: "board.item.upserted",
        audience: item.audience,
        payload: { boardId: caseFileBoard.boardId, boardRevision: caseFileBoard.revision + 1, item },
      });
      setConnectionError(undefined);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  const completeCaseFileEdge = (fromItemId: string, toItemId: string) => run(async () => {
    if (!session || !caseFileBoard) return;
    const from = caseFileBoard.items.find((item) => item.itemId === fromItemId);
    const to = caseFileBoard.items.find((item) => item.itemId === toItemId);
    if (!from || !to) return;
    const audience = intersectionAudience(from.audience, to.audience);
    const edge: BoardEdgeV1 = {
      schemaVersion: 1,
      edgeId: globalThis.crypto.randomUUID(),
      fromItemId,
      toItemId,
      kind: "relation",
      label: "",
      audience,
      extensions: {},
    };
    await session.submit({
      type: "board.edge.upserted",
      audience,
      payload: { boardId: caseFileBoard.boardId, boardRevision: caseFileBoard.revision + 1, edge },
    });
  });

  const prepareRoomAudio = () => run(async () => {
    if (!session?.isHost || audioOperation !== "idle") return;
    setAudioOperation("selecting");
    try {
      const imported = await selectAndImportAsset("audio");
      if (!imported) return;
      const artifactId = crypto.randomUUID();
      await addManagedAssetReference({
        assetId: imported.asset.assetId,
        ownerType: "artifact",
        ownerId: artifactId,
        ownerRevision: 1,
        slot: "audio.source",
      });
      await session.submit({
        type: "artifact.upserted",
        audience: { kind: "room" },
        payload: {
          artifact: {
            schemaVersion: 2,
            artifactId,
            revision: 1,
            kind: "ambience-audio",
            title: audioTitle.trim() || "氛围音乐",
            description: "由 KP 提供给房间成员的氛围音频",
            body: "",
            attachments: [imported.asset],
            audience: { kind: "room" },
            locked: true,
            archived: false,
            extensions: {},
          },
        },
      });
      setPreparedAudio(imported.asset);
    } finally {
      setAudioOperation("idle");
    }
  });

  const cueRoomAudio = () => run(async () => {
    if (!session?.isHost || !selectedAudio || audioOperation !== "idle") return;
    const attempt = ++audioCueAttemptRef.current;
    setAudioOperation("waiting");
    try {
      try {
        await session.waitForAssetReady(selectedAudio, { kind: "room" }, 30_000);
      } catch (cause) {
        if (attempt !== audioCueAttemptRef.current) return;
        throw cause;
      }
      if (attempt !== audioCueAttemptRef.current) return;
      setAudioOperation("starting");
      await session.submit({
        type: "audio.cued",
        audience: { kind: "room" },
        payload: {
          cueId: crypto.randomUUID(),
          asset: selectedAudio,
          loop: audioLoop,
          volume: audioVolume,
          fadeInMs: audioFadeInMs,
          startOffsetMs: audioStartOffsetMs,
        },
      });
    } finally {
      if (attempt === audioCueAttemptRef.current) setAudioOperation("idle");
    }
  });

  const cancelAudioWait = () => {
    audioCueAttemptRef.current += 1;
    setAudioOperation("idle");
  };

  const stopRoomAudio = () => run(async () => {
    if (!session?.isHost || audioOperation !== "idle") return;
    setAudioOperation("stopping");
    try {
      for (const cueId of world.activeAudio.keys()) {
        await session.submit({
          type: "audio.stopped",
          audience: { kind: "room" },
          payload: { cueId, fadeOutMs: audioFadeOutMs },
        });
      }
    } finally {
      setAudioOperation("idle");
    }
  });

  const issueInvitation = () => run(async () => {
    if (!session?.isHost || !newSeatName.trim()) return;
    const invitation = await session.issueSeatInvitation(newSeatName.trim());
    setLatestInvitation(encodeInvitationV2(invitation));
    setInvitationCopied(false);
    setNewSeatName("");
  });

  const rotateInvitation = (seatId: string) => run(async () => {
    if (!session?.isHost) return;
    const seatName = seats.find((seat) => seat.seatId === seatId)?.displayName ?? "这位玩家";
    if (!window.confirm(`确定为${seatName}换一份新邀请吗？旧邀请会立即失效；如果对方在线，也会暂时断开，需要用新邀请重新加入。`)) return;
    setLatestInvitation(encodeInvitationV2(await session.rotateSeatInvitation(seatId)));
    setInvitationCopied(false);
  });

  const copyLatestInvitation = async () => {
    if (!latestInvitation) return;
    try {
      await navigator.clipboard.writeText(latestInvitation);
      setInvitationCopied(true);
      setConnectionError(undefined);
    } catch {
      setInvitationCopied(false);
      setConnectionError("没有自动复制成功。请手动选中邀请文字并复制，再发给这位玩家。");
    }
  };

  const startNpcSession = (audience: AudienceV2) => {
    if (!session?.isHost || !pendingNpcSessionEntityId || npcSessionCreating) return;
    const npc = world.entities.get(pendingNpcSessionEntityId);
    if (!npc || npc.kind !== "npc") {
      setPendingNpcSessionEntityId(undefined);
      setConnectionError("这位 NPC 已不在当前房间资料中，请重新选择。");
      return;
    }
    if (!isAudienceSubsetV2(audience, npc.audience)) {
      setConnectionError("交谈的可见范围不能超过这位 NPC 本身的可见范围。");
      return;
    }
    setNpcSessionCreating(true);
    void run(async () => {
      const sessionId = globalThis.crypto.randomUUID();
      await session.submit({
        type: "npc.session.upserted",
        audience,
        payload: {
          session: {
            schemaVersion: 1,
            sessionId,
            revision: 1,
            npcEntityId: npc.entityId,
            title: `与 ${npc.name} 交谈`,
            description: "NPC 只能读取本面板的有限上下文",
            status: "active",
            audience,
            provider: "codex",
            model: "",
            autoReply: false,
            mode: "shadow",
            pinnedContext: [],
            startedAt: new Date().toISOString(),
            extensions: {},
          },
        },
      });
      setPendingNpcSessionEntityId(undefined);
      revealNpcConversation(sessionId);
    }).finally(() => setNpcSessionCreating(false));
  };

  const generateImageDraft = () => run(async () => {
    if (!session?.isHost || !imageKeeperAuthorization) return;
    setImageBusy(true);
    try {
      const draft = await codexImageExecutor.generateDraft({
        kind: imageKind,
        description: imageDescription,
        ...(imageStyle.trim() ? { style: imageStyle } : {}),
      }, imageKeeperAuthorization);
      setImageDraft(draft);
    } finally {
      setImageBusy(false);
    }
  });

  const cancelImageDraftGeneration = () => run(async () => {
    if (!imageKeeperAuthorization) return;
    await codexImageExecutor.cancel(imageKeeperAuthorization);
  });

  const bindImageDraft = () => run(async () => {
    if (!session?.isHost || !imageDraft || !imageTarget) return;
    if (!roomImageTargetOptions(imageDraft.kind, world).some(({ value }) => value === imageTarget)) {
      throw new Error("这项内容已经不再适合使用这类图片。请重新选择用途后再确认。");
    }
    const [targetKind, encodedTargetId] = imageTarget.split(":", 2);
    const targetId = encodedTargetId ?? "";
    const targetBoard = targetKind === "board" ? world.boards.get(targetId) : undefined;
    const targetEntity = targetKind === "entity" ? world.entities.get(targetId) : undefined;
    if (!targetBoard && !targetEntity) throw new Error("图片绑定目标已经不存在");
    const audience = targetBoard?.audience ?? targetEntity!.audience;
    const artifactId = globalThis.crypto.randomUUID();
    await addManagedAssetReference({
      assetId: imageDraft.asset.assetId,
      ownerType: "artifact",
      ownerId: artifactId,
      ownerRevision: 1,
      slot: targetBoard ? "board.background" : "entity.visual",
    });
    await session.submit({
      type: "artifact.upserted",
      audience,
      payload: {
        artifact: {
          schemaVersion: 2,
          artifactId,
          revision: 1,
          kind: targetBoard
            ? "map-background"
            : targetEntity?.kind === "npc"
              ? "npc-portrait"
              : targetEntity?.kind === "location"
                ? "location-background"
                : "image",
          title: targetBoard ? `${targetBoard.name} 背景` : `${targetEntity!.name} 图像`,
          description: imageDescription.trim(),
          body: "",
          attachments: [],
          asset: imageDraft.asset,
          ...(targetEntity ? { sourceEntityId: targetEntity.entityId } : {}),
          audience,
          locked: false,
          archived: false,
          extensions: { generatedBy: "codex-app-server", imageKind: imageDraft.kind },
        },
      },
    });
    if (targetBoard) {
      await session.submit({
        type: "board.updated",
        audience: targetBoard.audience,
        payload: {
          board: {
            ...targetBoard,
            revision: targetBoard.revision + 1,
            backgroundArtifactId: artifactId,
          },
        },
      });
    } else if (targetEntity) {
      await session.submit({
        type: "entity.upserted",
        audience: targetEntity.audience,
        payload: {
          entity: {
            ...targetEntity,
            revision: targetEntity.revision + 1,
            artifactIds: [...targetEntity.artifactIds, artifactId],
          },
        },
      });
    }
    setImageDraft(undefined);
    setImageDescription("");
  });

  const publishLocalEntityImage = async (asset: AssetDescriptorV1) => {
    if (!session?.isHost || !localImageEntityId) {
      throw new Error("请重新选择要绑定图片的地点或人物。");
    }
    const entity = world.entities.get(localImageEntityId);
    if (!entity || !isImageBearingEntityV2(entity)) {
      throw new Error("这项房间内容已不存在或不支持图片，请重新选择。");
    }
    await publishEntityImageV2({
      entity,
      asset,
      artifactId: globalThis.crypto.randomUUID(),
      retainAssetReference: addManagedAssetReference,
      submit: (proposal) => session.submit(proposal),
    });
  };

  const sendNpcPanelMessage = (role: "human" | "npc") => run(async () => {
    if (!session || !activeNpcSession || !npcMessage.trim()) return;
    if (activeNpcSession.status !== "active") {
      throw new Error(activeNpcSession.status === "closed"
        ? "这段 NPC 交谈已经结束，不能再发送消息。"
        : "这段 NPC 交谈已暂停，请等待 KP 恢复后再发送消息。");
    }
    await session.submitConfirmed({
      type: "npc.session.message",
      audience: activeNpcSession.audience,
      payload: {
        sessionId: activeNpcSession.sessionId,
        messageId: globalThis.crypto.randomUUID(),
        role,
        ...(role === "human" ? { speakerSeatId: session.localSeat.seatId } : {}),
        spokenText: npcMessage.trim(),
      },
    });
    setNpcMessage("");
  });

  const updateNpcSession = (
    update: (current: NpcInteractionSessionV1) => NpcInteractionSessionV1,
  ) => run(async () => {
    if (!session?.isHost || !activeNpcSession) return;
    const next = update(activeNpcSession);
    await session.submit({
      type: "npc.session.upserted",
      audience: next.audience,
      payload: { session: next },
    });
  });

  const stopNpcAutomation = (npcSession: NpcInteractionSessionV1) => run(async () => {
    if (!session?.isHost) return;
    await session.submit({
      type: "npc.session.upserted",
      audience: npcSession.audience,
      payload: {
        session: {
          ...npcSession,
          revision: npcSession.revision + 1,
          autoReply: false,
        },
      },
    });
  });

  const pauseNpcSession = () => updateNpcSession((current) => {
    if (current.status !== "active") throw new Error("只有正在进行的交谈可以暂停。");
    return {
      ...current,
      revision: current.revision + 1,
      status: "paused",
    };
  });

  const resumeNpcSession = () => updateNpcSession((current) => {
    if (current.status !== "paused") throw new Error("只有已暂停的交谈可以恢复。");
    const { endedAt: _endedAt, ...withoutEnd } = current;
    return {
      ...withoutEnd,
      revision: current.revision + 1,
      status: "active",
    };
  });

  const endNpcSession = () => updateNpcSession((current) => {
    if (current.status === "closed") throw new Error("这段交谈已经结束。");
    return {
      ...current,
      revision: current.revision + 1,
      status: "closed",
      autoReply: false,
      endedAt: new Date().toISOString(),
    };
  });

  const addNpcPin = () => updateNpcSession((current) => {
    const title = npcPinTitle.trim();
    const body = npcPinBody.trim();
    if (!title || !body) throw new Error("挂载资料需要标题和正文");
    if (current.pinnedContext.length >= 64) throw new Error("每个互动面板最多挂载 64 条资料");
    setNpcPinTitle("");
    setNpcPinBody("");
    return {
      ...current,
      revision: current.revision + 1,
      pinnedContext: [...current.pinnedContext, { pinId: globalThis.crypto.randomUUID(), title, body }],
    };
  });

  const publishNpcShadow = (shadow: NpcShadowReplyV1) => run(async () => {
    if (!session?.isHost || !activeNpcSession || shadow.sessionId !== activeNpcSession.sessionId) return;
    if (activeNpcSession.status !== "active") throw new Error("这段 NPC 交谈当前不能发布回应。");
    await session.submit({
      type: "npc.session.message",
      audience: activeNpcSession.audience,
      payload: {
        sessionId: activeNpcSession.sessionId,
        messageId: globalThis.crypto.randomUUID(),
        role: "npc",
        spokenText: shadow.reply.spokenText,
        ...(shadow.reply.stageDirection ? { stageDirection: shadow.reply.stageDirection } : {}),
        ...(shadow.reply.emotion ? { emotion: shadow.reply.emotion } : {}),
      },
    });
    onDismissNpcShadow?.(shadow.jobId);
  });

  const generateNpcStatsDraft = () => run(async () => {
    if (!session?.isHost) return;
    const npc = world.entities.get(npcStatsTargetId);
    if (!npc || npc.kind !== "npc") throw new Error("这位人物已经不在房间资料中，请重新选择。");
    setNpcStatsBusy(true);
    try {
      const draft = await tauriNpcStatsDraftExecutor.generateDraft({
        npcId: npc.entityId,
        name: npc.name,
        description: npc.description,
        guidance: npcStatsGuidance.trim(),
        provider: npcStatsProvider,
        model: npcStatsModel.trim(),
      }, new AbortController().signal);
      setNpcStatsDraft({ draft, sourceRevision: npc.revision });
    } finally {
      setNpcStatsBusy(false);
    }
  });

  const confirmNpcStatsDraft = () => run(async () => {
    if (!session?.isHost || !npcStatsDraft) return;
    const npc = world.entities.get(npcStatsDraft.draft.npcId);
    if (!npc || npc.kind !== "npc") throw new Error("这位人物已经不在房间资料中。");
    if (npc.revision !== npcStatsDraft.sourceRevision) {
      throw new Error("草稿生成后，这位人物的资料又被修改了。请重新生成，避免覆盖新内容。");
    }
    await session.submit({
      type: "entity.upserted",
      audience: npc.audience,
      payload: {
        entity: {
          ...npc,
          revision: npc.revision + 1,
          data: { ...npc.data, character: npcStatsDraft.draft.character },
          extensions: {
            ...npc.extensions,
            "org.coc-room.npc-stats.v1": {
              provider: npcStatsDraft.draft.provider,
              model: npcStatsDraft.draft.model,
              confirmedAt: new Date().toISOString(),
            },
          },
        },
      },
    });
    setNpcStatsDraft(undefined);
    setNpcStatsGuidance("");
  });

  const exportTranscript = async (format: "md" | "html") => {
    if (exportState.status === "working") return;
    setExportState({ status: "working", format });
    try {
      const embeddedAssets = format === "html" ? await prepareTranscriptAssetsV2(views) : undefined;
      const options = {
        roomName: room.name,
        roomId: room.id,
        seatName: session?.localSeat.displayName,
        seatId: room.localSeatId,
        ...(embeddedAssets === undefined ? {} : { embeddedAssets }),
      };
      const content = format === "md"
        ? exportEventsV2ToMarkdown(views, options)
        : exportEventsV2ToHtml(views, options);
      const filename = `${safeName(room.name)}-${new Date().toISOString().slice(0, 10)}.${format}`;
      if (window.__TAURI_INTERNALS__) {
        const path = await save({
          defaultPath: filename,
          filters: [{ name: format.toUpperCase(), extensions: [format] }],
        });
        if (!path) {
          setExportState({ status: "idle" });
          return;
        }
        await writeTextFile(path, content);
        setExportState({ status: "success", message: `已保存${exportFormatLabel(format)}。${offlineMediaExportNote(embeddedAssets)}` });
      } else {
        downloadTextInBrowser(
          filename,
          content,
          format === "html" ? "text/html;charset=utf-8" : "text/markdown;charset=utf-8",
        );
        setExportState({ status: "success", message: `${exportFormatLabel(format)}已开始下载。${offlineMediaExportNote(embeddedAssets)}` });
      }
    } catch (cause) {
      setExportState({
        status: "error",
        format,
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const openKeeperSceneWorkbench = () => {
    setMobileToolsOpen(true);
    globalThis.setTimeout(() => {
      document.getElementById("keeper-scene-workbench")?.scrollIntoView?.({ block: "start" });
    }, 0);
  };

  const openManualScenePresenter = () => {
    setMobileToolsOpen(true);
    globalThis.setTimeout(() => {
      document.getElementById("manual-scene-presenter")?.scrollIntoView?.({ block: "start" });
    }, 0);
  };

  const openActiveBoard = () => {
    setBoardExpanded(true);
    globalThis.setTimeout(() => {
      activeBoardSectionRef.current?.scrollIntoView?.({ block: "start" });
    }, 0);
  };

  const openPlayerCheckAction = () => {
    setActiveRoomTab("scene");
    setMobileToolsOpen(false);
    globalThis.setTimeout(() => {
      currentActionSectionRef.current?.scrollIntoView?.({ block: "start" });
    }, 0);
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-1 grid-rows-1 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section aria-hidden={mobileToolsOpen ? true : undefined} className="flex min-h-0 flex-col lg:border-r lg:border-zinc-800">
        <header className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${session?.isHost ? "bg-brass/15 text-brass" : "bg-sky-950 text-sky-300"}`}>{session?.isHost ? "KP" : "调查员"}</span>
              <h1 className="truncate font-serif text-xl text-ink">{room.name}</h1>
            </div>
            <p className="mt-1 text-xs text-zinc-500">{readOnly
              ? "正在查看本机保存的记录"
              : session?.isHost
                ? `${playerSeats.filter(({ peerId }) => peerId).length} 位调查员在线`
                : authenticationState === "authenticated"
                  ? "已进入调查"
                  : "正在确认你的邀请…"}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
          <button type="button" aria-label={session?.isHost ? "打开 KP 导演台" : "打开调查员工具"} onClick={() => setMobileToolsOpen(true)} className="grid h-9 w-9 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-ink lg:hidden"><Wrench className="h-4 w-4" /></button>
          <details className="relative">
            <summary aria-label="房间菜单" className="grid h-9 w-9 cursor-pointer list-none place-items-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-ink"><MoreHorizontal className="h-5 w-5" /></summary>
            <div className="absolute right-0 z-30 mt-2 grid w-52 gap-1 rounded-xl border border-zinc-800 bg-zinc-950 p-2 shadow-2xl">
              <button type="button" disabled={exportState.status === "working"} onClick={() => void exportTranscript("md")} className="flex items-center rounded-lg px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-60"><Download className="mr-2 h-4 w-4" />{exportState.status === "working" && exportState.format === "md" ? "正在准备…" : "导出文字记录"}</button>
              <button type="button" disabled={exportState.status === "working"} onClick={() => void exportTranscript("html")} className="flex items-center rounded-lg px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-60"><Download className="mr-2 h-4 w-4" />{exportState.status === "working" && exportState.format === "html" ? "正在准备…" : "导出网页记录"}</button>
              <button type="button" onClick={onLeave} className="flex items-center rounded-lg px-3 py-2 text-left text-sm text-red-300 hover:bg-red-950/40"><LogOut className="mr-2 h-4 w-4" />返回开始页</button>
            </div>
          </details>
          </div>
        </header>
        <nav aria-label="现场视图" className="flex border-b border-zinc-800 bg-zinc-950/40 px-3 sm:px-5">
          {([
            ["scene", "现场", Clapperboard, roomActionCount],
            ["clues", "调查案卷", FolderKanban, unseenPublicMaterialCount],
            ["record", "记录", FileText, 0],
          ] as const).map(([id, label, Icon, count]) => <button key={id} type="button" aria-label={label} aria-current={activeRoomTab === id ? "page" : undefined} onClick={() => setActiveRoomTab(id)} className={`flex h-11 items-center gap-2 border-b-2 px-3 text-sm transition ${activeRoomTab === id ? "border-brass text-brass" : "border-transparent text-zinc-500 hover:text-zinc-200"}`}><Icon className="h-4 w-4" />{label}{count > 0 && <span aria-hidden="true" className="min-w-5 rounded-full bg-brass/15 px-1.5 py-0.5 text-center text-[10px] text-brass">{count}</span>}</button>)}
        </nav>
        {!readOnly && session?.isHost && pendingModuleSceneEntries.length > 0 && <section role="status" aria-label="地图移动等待 KP 回应" className="flex flex-col gap-3 border-b border-amber-800/60 bg-amber-950/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-100">有 {pendingModuleSceneEntries.length} 处地图移动需要你回应</p>
            <p className="mt-1 truncate text-xs text-zinc-400">{pendingModuleSceneEntries.map(({ entry }) => `${entry.characters.map(({ entity }) => entity.name).join("、")} → ${entry.scene.name}`).join("；")}</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {board && <Button className="h-8 px-3 text-xs" variant="secondary" onClick={openActiveBoard}><Map className="mr-2 h-3.5 w-3.5" />打开地图</Button>}
            <Button className="h-8 px-3 text-xs" onClick={openKeeperSceneWorkbench}><Clapperboard className="mr-2 h-3.5 w-3.5" />准备呈现场景</Button>
          </div>
        </section>}
        {!readOnly && session && !session.isHost && (primaryOwnReadyCheck && primaryOwnReadyRequest || playerClosureHandoff) && <PlayerCheckHandoffBanner
          readyAuthorization={primaryOwnReadyCheck}
          readyRequest={primaryOwnReadyRequest}
          closure={playerClosureHandoff}
          onOpenAction={openPlayerCheckAction}
          onAcknowledgeClosure={(eventId) => setAcknowledgedPlayerClosureEventId(eventId)}
        />}
        {connectionError && <RoomErrorNoticeV2 error={connectionError} onDismiss={() => setConnectionError(undefined)} />}
        {exportState.status === "success" && <div role="status" className="flex items-center justify-between gap-3 border-b border-emerald-900 bg-emerald-950/25 px-5 py-2 text-xs text-emerald-200"><span>{exportState.message}</span><button type="button" className="rounded p-1 hover:bg-emerald-900/40" aria-label="关闭导出提示" onClick={() => setExportState({ status: "idle" })}><X className="h-3.5 w-3.5" /></button></div>}
        {exportState.status === "error" && <div role="alert" className="border-b border-red-900 bg-red-950/25 px-5 py-3 text-xs text-red-200"><div className="flex flex-wrap items-center justify-between gap-3"><div><b>导出没有完成，记录仍安全保存在本机。</b><p className="mt-1 text-red-200/80">请重试，或改用另一种格式。</p></div><Button variant="secondary" className="h-8 px-3 text-xs" onClick={() => void exportTranscript(exportState.format)}>重试导出</Button></div><details className="mt-2 text-red-200/70"><summary className="cursor-pointer">查看失败原因</summary><p className="mt-1 break-words">{exportState.detail}</p></details></div>}
        {!readOnly && session?.isHost && npcAutomationNotices.length > 0 && <div className="grid gap-2 border-b border-amber-900/50 bg-zinc-950 px-4 py-3 sm:px-5">
          {npcAutomationNotices.map(({ npcSession, latestStatus, pendingShadows }) => <section
            key={npcSession.sessionId}
            role={latestStatus?.status === "failed" ? "alert" : "status"}
            aria-label="NPC 自动回应状态"
            className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2 ${latestStatus?.status === "failed" ? "border-red-900/70 bg-red-950/20" : "border-amber-900/60 bg-amber-950/15"}`}
          >
            <div className="min-w-0">
              <p className="text-xs font-semibold text-zinc-200">{npcSession.title} · {pendingShadows.length > 0 ? `${pendingShadows.length} 条回应待审核` : latestStatus?.status === "failed" ? "扮演助手需要处理" : latestStatus?.status === "queued" || latestStatus?.status === "running" ? "扮演助手正在生成" : "扮演助手正在运行"}</p>
              <p className="mt-1 text-[11px] leading-5 text-zinc-500">{pendingShadows.length > 0 ? "草稿仍只在你的本机，确认后 NPC 才会说出。" : latestStatus?.message ?? "等待这段交谈中的下一条调查员发言。"}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="secondary" className="h-8 text-xs" onClick={() => revealNpcConversation(npcSession.sessionId)}>{pendingShadows.length > 0 ? "审核回应" : "打开交谈"}</Button>
              {npcSession.autoReply && npcSession.status === "active" && <Button variant="secondary" className="h-8 text-xs" onClick={() => void stopNpcAutomation(npcSession)}><Square className="mr-2 h-3.5 w-3.5" />立即停止</Button>}
            </div>
          </section>)}
        </div>}

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {activeRoomTab === "scene" && <>
          <section aria-label="当前情境" className={`mx-auto mb-5 max-w-6xl overflow-hidden rounded-2xl border ${activeScene ? "border-brass/30 bg-gradient-to-br from-brass/10 via-zinc-950 to-zinc-950" : "border-zinc-800 bg-zinc-950/50"}`}>
            {activeScene ? <div className="p-5 sm:p-7"><div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.2em] text-brass"><Clapperboard className="h-4 w-4" />当前情境</div><h2 className="mt-3 font-serif text-3xl text-ink">{activeScene.name}</h2>{activeScene.description ? <p className="mt-3 max-w-3xl whitespace-pre-wrap text-sm leading-7 text-zinc-300">{activeScene.description}</p> : <p className="mt-3 text-sm text-zinc-500">KP 已推进到这里，正在描述现场。</p>}{activeScenePresentations.length > 0 && <div className="mt-5 grid gap-3 border-t border-white/10 pt-4 md:grid-cols-2">{activeSceneLocations.length > 0 && <section aria-label="当前情境中的地点"><h3 className="flex items-center gap-2 text-xs font-semibold text-zinc-400"><Map className="h-3.5 w-3.5 text-brass" />眼前的地点</h3><div className="mt-2 grid gap-2">{activeSceneLocations.map((entity) => <article key={entity.entityId} className="rounded-lg bg-black/20 p-3"><b className="text-sm text-zinc-100">{entity.name}</b>{entity.description && <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-zinc-400">{entity.description}</p>}<VisibleEntityArtifactMediaV2 entity={entity} artifacts={world.artifacts} resolveAsset={resolveAsset} /></article>)}</div></section>}{activeSceneNpcs.length > 0 && <section aria-label="当前情境中的人物"><h3 className="flex items-center gap-2 text-xs font-semibold text-zinc-400"><UserRound className="h-3.5 w-3.5 text-brass" />已经登场</h3><div className="mt-2 grid gap-2">{activeSceneNpcs.map((entity) => <SceneNpcCard key={entity.entityId} entity={entity} artifacts={world.artifacts} resolveAsset={resolveAsset} conversation={findNpcConversation(world, entity.entityId)} isHost={session?.isHost === true} readOnly={readOnly} onStart={() => setPendingNpcSessionEntityId(entity.entityId)} onOpen={revealNpcConversation} />)}</div></section>}</div>}</div> : <div className="p-5 sm:p-7">
              <p className="text-[10px] font-semibold uppercase tracking-[.2em] text-zinc-600">当前情境</p>
              {readOnly ? <>
                <h2 className="mt-2 font-serif text-2xl text-zinc-300">记录中没有公开开场</h2>
                <p className="mt-2 text-sm leading-6 text-zinc-500">这份本地记录仍可查看和导出，但不能在只读房间中补写情境。</p>
              </> : session?.isHost ? world.activeModule ? <>
                <h2 className="mt-2 font-serif text-2xl text-zinc-300">{activeModulePackage ? activeModuleHasScenes ? "为调查员呈现第一幕" : "这个模组还没有可用场景" : activeModuleLoadError ? "模组开场暂时不可用" : "正在准备模组开场"}</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">{activeModulePackage
                  ? activeModuleHasScenes
                    ? "从本机模组中选择场景，再单独写下玩家此刻能感知到的开场。场景摘要和主持人笔记只留在你的导演台。"
                    : "模组已经载入，但结构化结果中没有场景。你可以先写一段只包含玩家可感知信息的临时开场，或返回模组库补全解析结果。"
                  : activeModuleLoadError
                    ? "本机模组资料暂时不可用。你可以先用不引用模组私密内容的临时开场继续跑团，之后再恢复备团资料。"
                    : `正在读取《${world.activeModule.title}》的本地备团资料。`}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {activeModuleHasScenes && <Button onClick={openKeeperSceneWorkbench}><Clapperboard className="mr-2 h-4 w-4" />选择并呈现开场</Button>}
                  {activeModuleLoadError && <Button onClick={openManualScenePresenter}><Clapperboard className="mr-2 h-4 w-4" />先用临时开场继续</Button>}
                  {activeModuleLoadError && <Button variant="secondary" onClick={() => setActiveView("modules")}><FolderKanban className="mr-2 h-4 w-4" />去 KP 备团</Button>}
                </div>
              </> : <>
                <h2 className="mt-2 font-serif text-2xl text-zinc-300">先呈现第一幕</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">没有模组也能直接开场：只写调查员此刻能看见、听见或感受到的内容。也可以先去备团，再从结构化场景开始。</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button onClick={openManualScenePresenter}><Clapperboard className="mr-2 h-4 w-4" />临时开场（不使用模组）</Button>
                  <Button variant="secondary" onClick={() => setActiveView("modules")}><FolderKanban className="mr-2 h-4 w-4" />去 KP 备团</Button>
                </div>
              </> : <>
                <h2 className="mt-2 font-serif text-2xl text-zinc-300">等待 KP 呈现开场</h2>
                <p className="mt-2 text-sm leading-6 text-zinc-500">你仍然可以在下方聊天，角色和案卷也随时可用。</p>
              </>}
            </div>}
            {!readOnly && session?.isHost && activeModuleHasNoScenes && <ZeroSceneModuleRecoveryV2
              moduleTitle={world.activeModule?.title ?? activeModulePackage?.metadata.title ?? "当前模组"}
              onManual={openManualScenePresenter}
              onRepair={() => setActiveView("modules")}
            />}
          </section>
          {showFirstInvitationCard && <section aria-label="发送第一份玩家邀请" className="mx-auto mb-5 max-w-4xl rounded-2xl border border-brass/40 bg-gradient-to-br from-brass/15 via-amber-950/10 to-zinc-950 p-5 sm:p-6">
            <p className="text-[10px] font-semibold uppercase tracking-[.2em] text-brass">开团第 1 步</p>
            <h2 className="mt-2 font-serif text-2xl text-ink">{latestInvitation ? "把这份专属邀请发给玩家" : "邀请第一位调查员"}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">{latestInvitation
              ? "邀请已经生成。复制前它会一直留在这里；把完整内容发给刚才填写的玩家，对方粘贴后即可加入。"
              : "先输入这位玩家的称呼。每个人会得到一份只属于自己的邀请，对方只需完整粘贴，不必理解其中的连接信息。"}</p>
            {!latestInvitation ? <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <Input aria-label="第一位玩家称呼" maxLength={80} value={newSeatName} onChange={(event) => setNewSeatName(event.target.value)} placeholder="例如：小林" />
              <Button className="sm:shrink-0" disabled={commandsDisabled || !newSeatName.trim()} onClick={() => void issueInvitation()}><UsersRound className="mr-2 h-4 w-4" />生成专属邀请</Button>
            </div> : <div className="mt-4 grid gap-3">
              <p aria-label="第一份玩家邀请内容" className="select-all break-all rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-[10px] leading-5 text-zinc-500">{latestInvitation}</p>
              <Button onClick={() => void copyLatestInvitation()}><Copy className="mr-2 h-4 w-4" />复制并发给这位玩家</Button>
            </div>}
          </section>}
          {!readOnly && session && !session.isHost && ownRoomCharacters.length === 0 && <section aria-label="下一步" className="mx-auto mb-5 max-w-4xl rounded-xl border border-amber-800/50 bg-amber-950/15 p-4">
            <h2 className="text-sm font-semibold text-amber-100">先带入你的调查员</h2>
            <p className="mt-1 text-xs leading-5 text-zinc-400">你可以先听 KP 描述；准备行动和检定前，只需创建或选择一张角色卡。</p>
            <Button className="mt-3" onClick={() => setActiveView("characters")}><UserRound className="mr-2 h-4 w-4" />去选择调查员</Button>
          </section>}
          {!readOnly && session && ((session.isHost && pendingCheckRequests.length > 0) || (!session.isHost && ownRoomCharacters.length > 0)) && <section ref={currentActionSectionRef} aria-label="当前行动" className="mx-auto scroll-mt-4 max-w-4xl">
            <CheckNegotiationV2
              world={world}
              session={session}
              readOnly={readOnly}
              waitingForKeeperOutcome={playerWaitingForKeeperOutcome}
              onError={setConnectionError}
            />
          </section>}
          {!readOnly && session && !session.isHost && board?.kind === "map" && playerMovableMapItems.length > 0 && <section aria-label="地图行动提示" className="mx-auto mb-5 max-w-4xl rounded-xl border border-sky-800/50 bg-sky-950/15 p-4">
            <h2 className="text-sm font-semibold text-sky-100">你可以在当前地图上移动自己的棋子</h2>
            <p className="mt-1 text-xs leading-5 text-zinc-400">用移动表达你准备前往的位置；地图不会自动公开场景、人物或线索，KP 会根据行动继续描述。</p>
            <Button className="mt-3" variant="secondary" onClick={openActiveBoard}><Map className="mr-2 h-4 w-4" />{boardExpanded ? `回到地图：${board.name}` : `打开地图：${board.name}`}</Button>
          </section>}
          {keeperNeedsToDescribeOutcome && <section aria-label="KP 下一步" className="mx-auto mb-5 max-w-4xl rounded-xl border border-emerald-800/50 bg-emerald-950/15 p-4">
            <h2 className="text-sm font-semibold text-emerald-100">{latestUnresolvedCheckSucceeded
              ? "描述这次成功带来的变化"
              : latestUnresolvedCheckWasPushed
                ? "结算你在强推前声明的严重代价"
                : "说明这次失败目前如何表现"}</h2>
            <p className="mt-1 text-xs leading-5 text-zinc-400">{latestUnresolvedCheckSucceeded
              ? "说清玩家达成了什么、现场发生了什么变化；若获得线索，再把对应内容公开到调查案卷。"
              : latestUnresolvedCheckWasPushed
                ? "强推失败后不要让玩家无事发生地再试一次。落实此前声明的代价，同时让故事继续向前。"
                : "先说明眼前的尝试为什么没有奏效。玩家收到这段结果后，才能换一种有实际区别的做法申请一次强推。"}</p>
            {latestUnresolvedCheckRequest && <p className="mt-2 rounded-lg bg-black/20 px-3 py-2 text-xs leading-5 text-zinc-300"><b>{latestUnresolvedCheckRequest.characterName}</b> 想要“{latestUnresolvedCheckRequest.goal ?? latestUnresolvedCheckRequest.reason}”，做法是“{latestUnresolvedCheckRequest.approach ?? latestUnresolvedCheckRequest.reason}”。</p>}
            <Textarea className="mt-3" aria-label="这次检定的叙述结果" aria-required="true" maxLength={4_000} value={checkOutcomeText} onChange={(event) => setCheckOutcomeText(event.target.value)} placeholder={latestUnresolvedCheckSucceeded ? "例如：夹层发出轻响，一封折叠的信落进你手中。" : latestUnresolvedCheckWasPushed ? "写下此前声明的严重代价，以及故事如何继续。" : "例如：锁芯没有转动，里面却传来一声金属碰撞；你可以换一种做法再试。"} />
            <div className="mt-3 flex flex-wrap gap-2">
              <Button disabled={commandsDisabled || !checkOutcomeText.trim()} onClick={() => void run(async () => {
                if (!session?.isHost || !latestUnresolvedCheckRequest) return;
                await session.submitConfirmed({
                  type: "check.outcome.described",
                  audience: latestUnresolvedCheckRequest.audience,
                  payload: { requestId: latestUnresolvedCheckRequest.requestId, text: checkOutcomeText.trim() },
                });
                setCheckOutcomeText("");
              })}>发布这次叙述结果</Button>
              {activeModulePackage && <Button variant="secondary" onClick={openKeeperSceneWorkbench}>查看当前场景的线索</Button>}
            </div>
          </section>}
          {keeperNeedsToDecideClue && latestCheckOutcomeEvent && <section aria-label="KP 下一步" className="mx-auto mb-5 max-w-4xl rounded-xl border border-emerald-800/50 bg-emerald-950/15 p-4">
            <h2 className="text-sm font-semibold text-emerald-100">这次行动带来了线索吗？</h2>
            <p className="mt-1 text-xs leading-5 text-zinc-400">如果玩家因此得到了新信息，把玩家可见的正文公开到共同案卷；没有线索时直接继续现场。</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => activeModulePackage ? openKeeperSceneWorkbench() : setActiveRoomTab("clues")}>{activeModulePackage ? "公开当前场景的线索" : "写一条公开线索"}</Button>
              <Button variant="secondary" onClick={() => setDismissedCluePromptForEventId(latestCheckOutcomeEvent.eventId)}>这次没有线索，继续</Button>
            </div>
          </section>}
          <section aria-labelledby="live-story" className="mx-auto max-w-4xl">
            <div className="mb-3 flex items-center justify-between"><h2 id="live-story" className="text-sm font-semibold text-zinc-300">正在发生</h2><span className="text-[10px] text-zinc-600">对话、检定与公开信息</span></div>
            <div className="grid gap-2">{liveStoryEvents.length === 0 ? <div className="rounded-xl border border-dashed border-zinc-800 px-4 py-8 text-center text-sm text-zinc-600">还没有现场记录。说出第一句开场，调查就开始了。</div> : liveStoryEvents.map((event) => <V2EventCard key={event.eventId} event={event} resolveAsset={resolveAsset} />)}</div>
            {unseenPublicMaterialCount > 0 && <button
              type="button"
              aria-label={unseenPublicMaterialIncludesSupportingMaterial ? `查看 ${unseenPublicMaterialCount} 项新资料` : `查看 ${unseenPublicMaterialCount} 条新线索`}
              onClick={() => setActiveRoomTab("clues")}
              className="mt-3 flex w-full flex-col justify-between gap-1 rounded-xl border border-emerald-800/50 bg-emerald-950/15 px-4 py-3 text-left text-sm text-emerald-100 hover:bg-emerald-950/30 sm:flex-row sm:items-center"
            ><span>{unseenPublicMaterialCount} {unseenPublicMaterialIncludesSupportingMaterial ? "项新资料" : "条新线索"}已进入共同案卷</span><span className="text-xs text-emerald-300">{session?.isHost ? "打开案卷确认公开结果 →" : unseenPublicMaterialIncludesSupportingMaterial ? "打开案卷查看正文与附件 →" : "查看后决定是否加入我的线索栏 →"}</span></button>}
          </section>
          <section ref={activeBoardSectionRef} aria-label="可选现场画面" className="mx-auto mt-6 max-w-6xl scroll-mt-4 rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.18em] text-zinc-600"><Map className="h-3.5 w-3.5" />可选视觉辅助</p>
                <h2 className="mt-1 truncate font-serif text-lg text-zinc-200">{board?.name ?? "本场暂不使用画面"}</h2>
                <p className="mt-1 text-xs leading-5 text-zinc-500">{board ? `${board.items.length} 个项目 · 需要辨认方位或移动棋子时再展开` : "当前情境与行动不依赖地图；需要方位、氛围图或关系板时再创建。"}</p>
              </div>
              {board ? <Button
                type="button"
                variant="secondary"
                aria-expanded={boardExpanded}
                aria-controls="active-board-view"
                onClick={() => setBoardExpanded((expanded) => !expanded)}
              >{boardExpanded ? `收起画面：${board.name}` : `展开画面：${board.name}`}</Button> : session?.isHost && !readOnly && <form className="grid shrink-0 gap-2 sm:grid-cols-[minmax(10rem,1fr)_auto_auto]" onSubmit={(event) => { event.preventDefault(); void createBoard(); }}>
                <Input aria-label="新画面名称" value={newBoardName} maxLength={120} onChange={(event) => setNewBoardName(event.target.value)} placeholder={`名称（留空为“${defaultBoardName(newBoardKind)}”）`} />
                <select aria-label="画面类型" className="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm" value={newBoardKind} onChange={(event) => setNewBoardKind(event.target.value as "scene" | "map")}><option value="scene">氛围场景</option><option value="map">方位地图</option></select>
                <Button type="submit" variant="secondary"><Plus className="mr-2 h-4 w-4" />创建可选画面</Button>
              </form>}
            </div>
            {board && boardExpanded && <div id="active-board-view" className="mt-4 border-t border-zinc-800 pt-4">
              <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <nav aria-label="现场画面" className="flex flex-wrap gap-2">{liveBoards.map((candidate) => <div key={candidate.boardId} className="flex rounded-lg border border-zinc-800 bg-zinc-950"><button type="button" disabled={!session?.isHost || readOnly || candidate.boardId === board.boardId} onClick={() => void activateBoard(candidate.boardId)} className="px-3 py-2 text-xs disabled:opacity-50">{candidate.name}</button>{session?.isHost && !readOnly && <button type="button" aria-label={`归档画面 ${candidate.name}`} title="归档后不再作为现场画面显示" onClick={() => void archiveBoard(candidate)} className="border-l border-zinc-800 px-2 text-xs text-red-300">归档</button>}</div>)}</nav>
                {session?.isHost && !readOnly && <details aria-label="新建现场画面" className="shrink-0 rounded-lg border border-zinc-800 bg-zinc-950/70 p-2 open:w-full open:lg:w-auto">
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-1 text-xs font-medium text-zinc-300"><Plus className="h-3.5 w-3.5" />新建另一张画面</summary>
                  <form className="mt-3 grid gap-2 border-t border-zinc-800 pt-3 sm:grid-cols-[minmax(11rem,1fr)_auto_auto]" onSubmit={(event) => { event.preventDefault(); void createBoard(); }}>
                    <Input aria-label="新画面名称" value={newBoardName} maxLength={120} onChange={(event) => setNewBoardName(event.target.value)} placeholder={`名称（留空为“${defaultBoardName(newBoardKind)}”）`} />
                    <select aria-label="画面类型" className="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm" value={newBoardKind} onChange={(event) => setNewBoardKind(event.target.value as "scene" | "map")}><option value="scene">氛围场景</option><option value="map">方位地图</option></select>
                    <Button type="submit" variant="secondary">创建并切换</Button>
                    <p className="text-[10px] leading-4 text-zinc-600 sm:col-span-3">当前画面会保留在列表中，不会被归档。</p>
                  </form>
                </details>}
              </div>
              <div className="mb-3 flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
                <p className="text-xs text-zinc-500">画面是现场的辅助，不会替代上方的情境与行动记录。</p>
                {session?.isHost && !readOnly && <div className="flex flex-wrap items-start justify-end gap-2">
                  {hasManagedAssetStore() && <BoardBackgroundPublisherV2
                    key={board.boardId}
                    boardName={board.name}
                    hasPublishedBackground={Boolean(backgroundAsset)}
                    availableAssets={activeModuleImageAssets}
                    onPublish={publishBoardBackground}
                    onError={setConnectionError}
                  />}
                  {!board.fogMask && <Button variant="ghost" onClick={() => void enableFog()}>添加迷雾</Button>}
                </div>}
              </div>
              <CollaborativeBoardCanvas
                board={board}
                artifacts={world.artifacts}
                backgroundUrl={backgroundResolution.url}
                backgroundState={backgroundResolution.state === "loading" || backgroundResolution.state === "error" ? backgroundResolution.state : undefined}
                readOnly={commandsDisabled}
                isKeeper={session?.isHost}
                canMoveItem={(item) => canSeatMoveBoardItem(world, board, item, session)}
                onSelectItem={(item) => setSelectedBoardItemId(item.itemId)}
                onPreview={(item) => session?.sendPreview({ boardId: board.boardId, itemId: item.itemId, x: item.position.x, y: item.position.y, action: "drag" })}
                onCommitItem={commitItem}
                onCompleteEdge={session?.isHost || board.kind === "evidence" ? (from, to) => void completeEdge(from, to) : undefined}
                onCompleteFogRegion={(points) => void completeFog(points)}
                onExternalDrop={session?.isHost && activeModulePackage && !readOnly
                  ? (payload, point) => void run(() => handleModuleSceneDropV2(session, activeModulePackage, board.boardId, payload, point))
                  : undefined}
              />
            </div>}
          </section>
          </>}

          {activeRoomTab === "clues" && <div className="mx-auto grid max-w-6xl gap-5">
            <PublicClueBoardV2
              world={world}
              session={session}
              board={caseFileBoard}
              readOnly={readOnly}
              onError={setConnectionError}
              resolveAsset={resolveAsset}
            />
            <Panel className="grid gap-3 p-4" aria-label="共享推理板">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                <div><h2 className="font-serif text-lg">共享推理板</h2><p className="mt-1 max-w-2xl text-xs leading-5 text-zinc-500">这是案卷的一张可选关系图，不会替代上方的公开线索。所有能看见它的人都可以摆放未锁定内容和连接关系。</p></div>
                {!readOnly && session?.isHost && <Button className="shrink-0" variant="secondary" onClick={() => void createCaseFileBoard()}><Plus className="mr-2 h-4 w-4" />新建推理板</Button>}
              </div>
              {evidenceBoards.length > 1 && <Field label="正在查看"><select aria-label="选择共享推理板" className="h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm" value={caseFileBoard?.boardId ?? ""} onChange={(event) => setCaseFileBoardId(event.target.value)}>{evidenceBoards.map((candidate) => <option key={candidate.boardId} value={candidate.boardId}>{candidate.name}</option>)}</select></Field>}
              {caseFileBoard ? <CollaborativeBoardCanvas
                board={caseFileBoard}
                artifacts={world.artifacts}
                backgroundUrl={caseFileBackgroundResolution.url}
                backgroundState={caseFileBackgroundResolution.state === "loading" || caseFileBackgroundResolution.state === "error" ? caseFileBackgroundResolution.state : undefined}
                readOnly={commandsDisabled}
                isKeeper={session?.isHost}
                canMoveItem={(item) => canSeatMoveBoardItem(world, caseFileBoard, item, session)}
                onPreview={(item) => session?.sendPreview({ boardId: caseFileBoard.boardId, itemId: item.itemId, x: item.position.x, y: item.position.y, action: "drag" })}
                onCommitItem={commitCaseFileItem}
                onCompleteEdge={(from, to) => void completeCaseFileEdge(from, to)}
              /> : <div className="rounded-lg border border-dashed border-zinc-800 p-5 text-center">
                <p className="text-sm text-zinc-400">这局还没有共享推理板。</p>
                <p className="mt-1 text-xs leading-5 text-zinc-600">{session?.isHost ? "需要整理人物、地点与线索关系时再创建；普通调查不依赖画板。" : "KP 创建后会出现在这里；在此之前，共同案卷仍可正常使用。"}</p>
              </div>}
            </Panel>
            <ArtifactWorkspaceV2
              world={world}
              session={session}
              readOnly={readOnly}
              onError={setConnectionError}
              listMode="supporting-materials"
              heading="手记与笔记"
              description="这里收纳大家共同补充的手记、笔记和私密线索。已经公开的线索统一显示在上方调查案卷，不再重复一遍。"
              emptyMessage="还没有手记、笔记或仅你可见的线索。"
              resolveAsset={resolveAsset}
            />
          </div>
          }

          {activeRoomTab === "record" && <section aria-labelledby="room-record" className="mx-auto max-w-4xl">
            <div className="mb-4"><h2 id="room-record" className="font-serif text-2xl">团务记录</h2><p className="mt-1 text-sm text-zinc-500">这里只保留人能读懂的对话、检定与重要公开事件；拖拽和同步细节不会打扰阅读。</p></div>
            {humanRecordEvents.length > 0 && <div className="mb-4 grid gap-3 rounded-xl border border-zinc-800 bg-zinc-950/45 p-3">
              <Input
                aria-label="搜索团务记录"
                value={recordQuery}
                onChange={(event) => setRecordQuery(event.target.value)}
                placeholder="搜索人物、发言、线索或检定…"
              />
              <div role="group" aria-label="记录类别" className="flex flex-wrap gap-2">
                {HUMAN_RECORD_CATEGORIES.map(({ id, label }) => <button
                  key={id}
                  type="button"
                  aria-pressed={recordCategory === id}
                  onClick={() => setRecordCategory(id)}
                  className={`rounded-full border px-3 py-1.5 text-xs transition ${recordCategory === id ? "border-brass/60 bg-brass/10 text-brass" : "border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-200"}`}
                >{label}</button>)}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <p role="status" className="text-zinc-500">显示 {filteredRecordEvents.length} / {humanRecordEvents.length} 条记录</p>
                {recordFiltersActive && <button type="button" onClick={() => { setRecordCategory("all"); setRecordQuery(""); }} className="text-brass hover:underline">清除筛选</button>}
              </div>
              <p className="text-[11px] leading-4 text-zinc-600">筛选只改变当前屏幕；导出仍会包含你有权查看的全部记录。</p>
            </div>}
            <div className="grid gap-2">{humanRecordEvents.length === 0
              ? <p className="rounded-xl border border-dashed border-zinc-800 py-10 text-center text-sm text-zinc-600">还没有可读记录。</p>
              : filteredRecordEvents.length === 0
                ? <p className="rounded-xl border border-dashed border-zinc-800 py-10 text-center text-sm text-zinc-600">没有找到符合条件的记录。换个关键词，或清除筛选后再看。</p>
                : filteredRecordEvents.map((event) => <V2EventCard key={event.eventId} event={event} resolveAsset={resolveAsset} />)}</div>
          </section>}
        </div>

        {!readOnly && <div className="border-t border-zinc-800 bg-zinc-950/80 p-4">
          <div className="mx-auto flex max-w-4xl items-end gap-2">
            <div className="min-w-0 flex-1">
            <Textarea
              ref={messageInputRef}
              rows={2}
              value={message}
              disabled={commandsDisabled}
              aria-label="现场发言"
              className="max-h-40 min-h-[3.25rem] resize-y py-2.5"
              placeholder={authenticationState === "authenticated" || session?.isHost ? session?.isHost ? "描述行动造成的结果，或继续讲述现场…" : "与人交谈、追问细节，或做无需检定的简单行动…" : "正在确认你的邀请…"}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void sendChat();
                }
              }}
            />
            <p className="mt-1 text-[10px] text-zinc-600">Enter 发送 · Shift+Enter 换行</p>
            </div>
            <Button aria-label="发送消息" disabled={commandsDisabled || message.trim().length === 0} onClick={() => void sendChat()}><Send className="h-4 w-4" /></Button>
          </div>
        </div>}
      </section>

      <aside
        ref={mobileToolsPanelRef}
        role={mobileToolsOpen ? "dialog" : undefined}
        aria-modal={mobileToolsOpen ? true : undefined}
        aria-labelledby={mobileToolsOpen ? "mobile-room-tools-title" : undefined}
        aria-label={mobileToolsOpen ? undefined : session?.isHost ? "KP 导演台" : "调查员工具"}
        className={`${mobileToolsOpen ? "fixed inset-x-0 bottom-16 top-0 z-40 block" : "hidden"} min-h-0 overflow-y-auto border-zinc-800 bg-zinc-950 p-4 lg:static lg:block lg:border-l lg:bg-zinc-950/30`}
      >
        <div className="sticky top-0 z-10 -mx-4 -mt-4 mb-4 flex items-center justify-between border-b border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur lg:hidden">
          <div><p className="text-[10px] font-semibold uppercase tracking-[.18em] text-brass">{session?.isHost ? "KP" : "调查员"}</p><h2 id="mobile-room-tools-title" className="font-serif text-lg">{session?.isHost ? "导演台" : "我的工具"}</h2></div>
          <button ref={mobileToolsCloseRef} type="button" aria-label="关闭工具" onClick={() => setMobileToolsOpen(false)} className="grid h-11 w-11 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-ink"><X className="h-5 w-5" /></button>
        </div>
        {mobileToolsOpen && !readOnly && session && !session.isHost && (primaryOwnReadyCheck && primaryOwnReadyRequest || playerClosureHandoff) && <PlayerCheckHandoffBanner
          readyAuthorization={primaryOwnReadyCheck}
          readyRequest={primaryOwnReadyRequest}
          closure={playerClosureHandoff}
          compact
          onOpenAction={openPlayerCheckAction}
          onAcknowledgeClosure={(eventId) => setAcknowledgedPlayerClosureEventId(eventId)}
        />}
        <Panel className="mb-4 grid gap-3 border-brass/20 p-4">
          <div className="flex items-center justify-between"><div><p className="text-[10px] font-semibold uppercase tracking-[.18em] text-brass">{session?.isHost ? "导演台" : "我的桌面"}</p><h2 className="mt-1 font-serif text-xl">{session?.isHost ? "下一步做什么" : "当前状态"}</h2></div><span className={`h-2.5 w-2.5 rounded-full ${readOnly ? "bg-zinc-600" : authenticationState === "authenticated" || session?.isHost ? "bg-emerald-400" : "bg-amber-400"}`} /></div>
          {readOnly ? <p className="text-sm leading-6 text-zinc-500">这是本机保存的只读记录。你仍可查看案卷并导出。</p> : session?.isHost ? <>
            {(!world.activeModule || Boolean(activeModuleLoadError) || activeModuleHasNoScenes) && <>
              {activeModuleHasNoScenes && <ZeroSceneModuleRecoveryV2
                moduleTitle={world.activeModule?.title ?? activeModulePackage?.metadata.title ?? "当前模组"}
                onManual={openManualScenePresenter}
                onRepair={() => setActiveView("modules")}
                compact
              />}
              <ManualScenePresenterV2 world={world} session={session} readOnly={readOnly} onError={setConnectionError} />
              {!world.activeModule && <div className="rounded-lg bg-zinc-950 p-3"><p className="text-xs leading-5 text-zinc-500">也可以先把模组整理成场景、人物与线索，再从导演台逐步公开。</p><Button className="mt-3 h-8 text-xs" variant="secondary" onClick={() => setActiveView("modules")}><FolderKanban className="mr-2 h-3.5 w-3.5" />去 KP 备团</Button></div>}
            </>}
            {world.activeModule && activeModuleLoading && <p role="status" className="rounded-lg bg-zinc-950 p-3 text-sm text-zinc-400"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />正在打开《{world.activeModule.title}》的备团资料…</p>}
            {world.activeModule && !activeModuleLoading && activeModuleHasScenes && <p className="rounded-lg bg-emerald-950/20 p-3 text-sm text-emerald-200">已打开《{world.activeModule.title}》。从下面选择当前场景，并只公开玩家此刻应该知道的内容。</p>}
            {world.activeModule && !activeModuleLoading && activeModuleLoadError && <div role="alert" className="rounded-lg border border-amber-900/70 bg-amber-950/20 p-3"><p className="text-sm font-medium text-amber-100">这局引用了《{world.activeModule.title}》，但本机暂时打不开对应的备团资料。</p><p className="mt-1 text-xs leading-5 text-zinc-400">玩家已经收到的内容和记录不受影响。可以重新读取，或去模组库重新导入/换用正确版本。</p><div className="mt-3 flex flex-wrap gap-2"><Button className="h-8 text-xs" variant="secondary" onClick={() => setActiveModuleLoadAttempt((attempt) => attempt + 1)}><RefreshCw className="mr-2 h-3.5 w-3.5" />重新读取</Button><Button className="h-8 text-xs" variant="ghost" onClick={() => setActiveView("modules")}><FolderKanban className="mr-2 h-3.5 w-3.5" />去模组库处理</Button></div><details className="mt-2 text-[11px] text-zinc-600"><summary className="cursor-pointer">查看失败原因</summary><p className="mt-1 break-words">{activeModuleLoadError}</p></details></div>}
            {playerSeats.length === 0 && <p className="text-xs leading-5 text-amber-300">还没有邀请玩家。第一份专属邀请已经放在现场顶部，生成并复制后直接发给对方即可。</p>}
            {pendingCheckRequests.length > 0 && <p className="rounded-lg bg-amber-950/25 p-3 text-sm text-amber-200">有 {pendingCheckRequests.length} 个行动等你裁定，已经放在现场情境下方。</p>}
            {playerSeats.length > 0 && <p className="text-xs text-zinc-500">{playerSeats.filter(({ peerId }) => peerId).length}/{playerSeats.length} 位调查员在线 · {world.latestCharacters.size} 张房间角色卡</p>}
          </> : ownRoomCharacters.length === 0 ? <div className="rounded-lg bg-amber-950/20 p-3"><p className="text-sm font-medium text-amber-200">你还没有带入调查员</p><p className="mt-1 text-xs leading-5 text-zinc-500">可以先听 KP 开场，但检定和个人线索需要一张房间角色卡。</p><Button className="mt-3 h-8 text-xs" onClick={() => setActiveView("characters")}><UserRound className="mr-2 h-3.5 w-3.5" />创建或选择调查员</Button></div> : ownRoomCharacters.map((character) => <div key={character.id} className="rounded-lg bg-zinc-950 p-3"><div className="flex items-center justify-between"><b className="text-sm">{character.name}</b><button type="button" onClick={() => setActiveView("characters")} className="text-[11px] text-brass hover:underline">打开角色卡</button></div><div className="mt-2 grid grid-cols-3 gap-2 text-center text-[11px]"><span className="rounded bg-zinc-900 p-1.5 text-zinc-400">HP <b className="text-ink">{character.derived.hitPoints}</b></span><span className="rounded bg-zinc-900 p-1.5 text-zinc-400">SAN <b className="text-ink">{character.derived.sanity}</b></span><span className="rounded bg-zinc-900 p-1.5 text-zinc-400">幸运 <b className="text-ink">{character.characteristics.luck}</b></span></div></div>)}
        </Panel>

        {!showFirstInvitationCard && !readOnly && session?.isHost && <ToolDisclosure title="玩家与邀请" icon={UsersRound} hint={playerSeats.length === 0 ? "先邀请第一位调查员" : `已邀请 ${playerSeats.length} 位调查员`}>
        <Panel className="grid gap-3 p-4">
          <h2 className="text-sm font-semibold">邀请一位玩家</h2>
          <div className="flex gap-2"><Input aria-label="玩家称呼" maxLength={80} value={newSeatName} onChange={(event) => setNewSeatName(event.target.value)} placeholder="例如：小林" /><Button disabled={commandsDisabled || !newSeatName.trim()} onClick={() => void issueInvitation()}>生成邀请</Button></div>
          {latestInvitation && <><p className="select-all break-all rounded bg-zinc-950 p-2 font-mono text-[10px] leading-4 text-zinc-500">{latestInvitation}</p><Button variant="secondary" onClick={() => void copyLatestInvitation()}>{invitationCopied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}{invitationCopied ? "已复制，可以发给这位玩家" : "复制并发给这位玩家"}</Button></>}
          <p className="text-[11px] leading-4 text-zinc-600">每位玩家都要使用自己的邀请。对方只需完整粘贴，不必理解其中的连接信息。</p>
          <div className="border-t border-zinc-800 pt-3"><h3 className="mb-2 text-xs font-semibold text-zinc-400">玩家状态</h3><div className="grid gap-2 text-sm">{seats.map((seat) => <div key={seat.seatId} className="flex items-center justify-between gap-2"><span className="truncate">{seat.displayName}{seat.role === "host" ? "（KP）" : ""}</span><div className="flex items-center gap-2"><span className="text-xs text-zinc-500">{seat.peerId ? pathLabel(paths[seat.peerId]) : "离线"}</span>{session?.isHost && seat.role === "player" && <button type="button" aria-label={`为 ${seat.displayName} 换新邀请`} className="text-[11px] text-brass hover:underline" onClick={() => void rotateInvitation(seat.seatId)}>换新邀请</button>}</div></div>)}</div></div>
        </Panel></ToolDisclosure>}

        {!readOnly && session?.isHost && activeModulePackage && activeModuleHasScenes && <KeeperModuleWorkbenchV2
          modulePackage={activeModulePackage}
          world={world}
          board={board}
          session={session}
          readOnly={readOnly}
          onError={setConnectionError}
        />}

        {!readOnly && session?.isHost && board && <ToolDisclosure title="画面与棋子" icon={Map} hint={selectedBoardItem ? `已选：${selectedBoardItem.label || "未命名项目"}` : `${board.items.length} 个项目`}>
          <Panel className="grid gap-3 p-4">
            <div><h2 className="text-sm font-semibold">{board.name}</h2><p className="mt-1 text-xs leading-5 text-zinc-500">点一下画面中的项目再调整。玩家在地图上默认只能移动自己的调查员棋子。</p></div>
            {board.items.length > 0 && <div className="flex flex-wrap gap-1">{board.items.map((item) => <button key={item.itemId} type="button" aria-pressed={selectedBoardItemId === item.itemId} onClick={() => setSelectedBoardItemId(item.itemId)} className={`rounded px-2 py-1.5 text-xs ${selectedBoardItemId === item.itemId ? "bg-brass/15 text-brass" : "bg-zinc-900 text-zinc-400"}`}>{item.label || "未命名项目"}</button>)}</div>}
            {!selectedBoardItem && <p className="rounded border border-dashed border-zinc-800 p-4 text-center text-xs text-zinc-600">当前没有选中项目。</p>}
            {selectedBoardItem && <div className="grid gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
              <div className="flex items-center justify-between gap-2"><b className="text-sm">{selectedBoardItem.label || "未命名项目"}</b><span className="text-xs text-zinc-600">{selectedBoardItem.locked ? "已锁定" : "可移动"}</span></div>
              <div className="grid grid-cols-2 gap-2"><Button className="h-8 text-xs" variant="secondary" onClick={() => commitSelectedBoardItem({ ...selectedBoardItem, locked: !selectedBoardItem.locked })}>{selectedBoardItem.locked ? "解锁项目" : "锁定项目"}</Button><Button className="h-8 text-xs" variant="secondary" onClick={() => commitSelectedBoardItem({ ...selectedBoardItem, rotationDegrees: normalizeRotation(selectedBoardItem.rotationDegrees + 15) })}>顺时针旋转</Button><Button className="h-8 text-xs" variant="secondary" onClick={() => commitSelectedBoardItem({ ...selectedBoardItem, scale: clampBoardScale(selectedBoardItem.scale - 0.1) })}>缩小</Button><Button className="h-8 text-xs" variant="secondary" onClick={() => commitSelectedBoardItem({ ...selectedBoardItem, scale: clampBoardScale(selectedBoardItem.scale + 0.1) })}>放大</Button></div>
              <Button className="h-8 text-xs" variant="ghost" onClick={() => void removeBoardItem(selectedBoardItem)}>从当前画面移除</Button>
            </div>}
          </Panel>
        </ToolDisclosure>}

        {!readOnly && session?.isHost && <ToolDisclosure title="帮人物补全属性" icon={UserRound} hint="需要检定数据时再使用">
        <Panel className="grid gap-3 p-4">
          <div className="flex items-center gap-2"><UserRound className="h-4 w-4 text-brass" /><h2 className="text-sm font-semibold">生成 NPC 属性草稿</h2></div>
          <p className="text-[11px] leading-4 text-zinc-500">助手只会读取这个人物的名称、公开描述和你的补充要求。结果先给 KP 检查，确认前不会改变房间里的资料。</p>
          <Field label="要补全哪位人物"><select aria-label="NPC 属性草稿目标" className="h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm" value={npcStatsTargetId} onChange={(event) => { setNpcStatsTargetId(event.target.value); setNpcStatsDraft(undefined); }}><option value="">选择人物</option>{[...world.entities.values()].filter((entity) => entity.kind === "npc").map((npc) => <option key={npc.entityId} value={npc.entityId}>{npc.name}</option>)}</select></Field>
          {[...world.entities.values()].every((entity) => entity.kind !== "npc") && <p className="rounded border border-dashed border-zinc-800 p-3 text-xs leading-5 text-zinc-500">还没有可选人物。先从模组导演台向房间介绍人物，或在“临时补充内容”中创建一位。</p>}
          <Textarea aria-label="NPC 属性补充要求" value={npcStatsGuidance} maxLength={50_000} onChange={(event) => { setNpcStatsGuidance(event.target.value); setNpcStatsDraft(undefined); }} placeholder="例如：年迈但观察敏锐，不擅长战斗" />
          <Button disabled={!npcStatsTargetId || npcStatsBusy} onClick={() => void generateNpcStatsDraft()}>{npcStatsBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}生成属性草稿</Button>
          <details className="rounded border border-zinc-800 px-3 py-2 text-xs text-zinc-500">
            <summary className="cursor-pointer">更换 AI 服务（通常不用改）</summary>
            <div className="mt-3 grid grid-cols-2 gap-2 border-t border-zinc-800 pt-3">
              <Field label="AI 服务"><select aria-label="NPC 属性草稿提供者" className="h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm" value={npcStatsProvider} onChange={(event) => { setNpcStatsProvider(event.target.value as NpcStatsProvider); setNpcStatsDraft(undefined); }}><option value="codex">Codex</option><option value="deepseek">DeepSeek</option></select></Field>
              <Field label="指定模型（可留空）"><Input aria-label="NPC 属性草稿模型" value={npcStatsModel} maxLength={100} onChange={(event) => { setNpcStatsModel(event.target.value); setNpcStatsDraft(undefined); }} placeholder="使用默认选择" /></Field>
            </div>
          </details>
          {npcStatsDraft && <div className="grid gap-2 rounded-md border border-amber-800/60 bg-amber-950/20 p-3 text-xs">
            <p className="font-semibold text-amber-200">只有你能看到 · 确认后才会更新人物</p>
            <p className="text-zinc-400">属性：{formatNpcStats(npcStatsDraft.draft.character.characteristics)}</p>
            <p className="text-zinc-400">技能：{formatNpcStats(npcStatsDraft.draft.character.skills) || "无"}</p>
            <p className="text-zinc-400">HP {npcStatsDraft.draft.character.hitPoints}{npcStatsDraft.draft.character.sanity === undefined ? "" : ` · SAN ${npcStatsDraft.draft.character.sanity}`}</p>
            <div className="flex gap-2"><Button onClick={() => void confirmNpcStatsDraft()}><Check className="mr-2 h-4 w-4" />确认并更新人物</Button><Button variant="secondary" onClick={() => setNpcStatsDraft(undefined)}>不要这份</Button></div>
          </div>}
        </Panel></ToolDisclosure>}

        {!readOnly && <ToolDisclosure title="自由掷骰" icon={Dices} hint="没有检定上下文时使用">
        <Panel className="grid gap-3 p-4">
          <div className="flex items-center gap-2"><Dices className="h-4 w-4 text-brass" /><h2 className="text-sm font-semibold">临时掷骰</h2></div>
          <Field label="骰式"><Input value={dice} disabled={commandsDisabled} onChange={(event) => setDice(event.target.value)} /></Field>
          <Field label="为什么掷骰"><Input value={reason} disabled={commandsDisabled} onChange={(event) => setReason(event.target.value)} placeholder="例如：决定从高处跳下是否受伤" /></Field>
          <Button disabled={commandsDisabled} onClick={() => void roll()}>掷骰并记录</Button>
        </Panel></ToolDisclosure>}

        {!readOnly && session?.isHost && <ToolDisclosure title="地点与人物图片" icon={ImagePlus} hint="本地上传 · 先预览再公开">
        <Panel className="grid gap-3 p-4">
          <div className="flex items-center gap-2"><ImagePlus className="h-4 w-4 text-brass" /><h2 className="text-sm font-semibold">为已发布内容添加图片</h2></div>
          <p className="text-[11px] leading-5 text-zinc-500">选择地点、NPC 或调查员，再从电脑或模组素材选图。确认前只有 KP 本机能看到预览，房间事件中不会出现图片描述符。</p>
          <Field label="图片要绑定到哪里"><select
            aria-label="本地图片绑定目标"
            className="h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm"
            value={localImageEntityId}
            onChange={(event) => setLocalImageEntityId(event.target.value)}
          >
            <option value="">选择已发布的地点或人物</option>
            {localImageEntities.map((entity) => <option key={entity.entityId} value={entity.entityId}>{roomEntityKindLabel(entity.kind)}“{entity.name}”</option>)}
          </select></Field>
          {localImageEntities.length === 0 && <p className="rounded border border-dashed border-zinc-800 p-3 text-xs leading-5 text-zinc-500">房间中还没有可绑定图片的地点、NPC 或调查员。先发布地点或人物，或让玩家带入角色。</p>}
          {localImageEntity && isImageBearingEntityV2(localImageEntity) && (hasManagedAssetStore()
            ? <EntityImagePublisherV2
                key={localImageEntity.entityId}
                entity={localImageEntity}
                hasPublishedImage={hasPublishedEntityImageV2(localImageEntity, world.artifacts)}
                availableAssets={activeModuleImageAssets}
                onPublish={publishLocalEntityImage}
                onError={setConnectionError}
              />
            : <p role="alert" className="rounded border border-amber-900/60 bg-amber-950/15 p-3 text-xs leading-5 text-amber-200">当前浏览器不支持开发资源库，不能安全导入图片。请使用启用了 IndexedDB 与 Web Crypto 的本机网页，或桌面应用；这项能力不依赖 AI 凭据。</p>)}
        </Panel></ToolDisclosure>}

        {!readOnly && session?.isHost && <ToolDisclosure title="图片草稿" icon={Sparkles} hint="低频 · 生成后审核">
        <Panel className="grid gap-3 p-4">
          <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-brass" /><h2 className="text-sm font-semibold">生成一张图片草稿</h2></div>
          <p className="text-[11px] leading-4 text-zinc-500">一次只生成一张。图片先留给 KP 检查，确认前不会出现在玩家画面或资料中。</p>
          {imageCapabilities && <p className={`text-[11px] ${imageCapabilities.imageGeneration ? "text-emerald-400" : "text-amber-300"}`}>
            {imageCapabilities.imageGeneration ? "图片能力可用" : imageCapabilities.message ?? "当前 Codex 会话没有图片能力"}
          </p>}
          <Field label="要生成什么"><select aria-label="图片类型" className="h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm" value={imageKind} onChange={(event) => { setImageKind(event.target.value as CodexImageJobKind); setImageTarget(""); setImageDraft(undefined); }}>
            <option value="location">地点背景</option><option value="npc">NPC 肖像</option><option value="character">调查员肖像</option><option value="textlessMap">无文字地图</option>
          </select></Field>
          <Field label="生成后准备用在哪里" hint="先确定用途，避免花费额度后才发现没有合法位置。"><select aria-label="图片使用位置" className="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm" value={imageTarget} onChange={(event) => setImageTarget(event.target.value)}><option value="">选择一个位置</option>{imageTargetOptions.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select></Field>
          {imageTargetOptions.length === 0 && <p className="rounded border border-dashed border-zinc-800 p-3 text-xs leading-5 text-zinc-500">{imageTargetEmptyMessage(imageKind)}</p>}
          <Textarea aria-label="图片内容" value={imageDescription} maxLength={4_000} onChange={(event) => setImageDescription(event.target.value)} placeholder="描述画面，例如：雨夜里的旧剧院后门，昏暗煤气灯。地图中不要要求生成文字，地名可在画面上另行标注。" />
          <Field label="画面风格（可留空）"><Input value={imageStyle} maxLength={500} onChange={(event) => setImageStyle(event.target.value)} placeholder="例如：旧纸蚀刻、昏暗写实" /></Field>
          <div className="flex gap-2">
            <Button className="flex-1" disabled={imageBusy || !imageTarget || !imageDescription.trim() || imageCapabilities?.imageGeneration !== true} onClick={() => void generateImageDraft()}>
              {imageBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}生成一个候选
            </Button>
            {imageBusy && <Button variant="secondary" onClick={() => void cancelImageDraftGeneration()}><Square className="mr-2 h-4 w-4" />立即停止</Button>}
          </div>
          {imageDraft && <div className="grid gap-3 rounded-lg border border-amber-800/50 bg-amber-950/10 p-3">
            {imageDraftUrl && <img src={imageDraftUrl} alt="待审核的 Codex 图片草稿" className="max-h-56 w-full rounded object-contain" />}
            <p className="text-[11px] text-amber-200">只有你能看到 · 确认后才会用于{selectedImageTargetLabel ? `“${selectedImageTargetLabel}”` : "刚才选择的位置"}</p>
            <div className="flex gap-2"><Button disabled={!imageTarget} onClick={() => void bindImageDraft()}><Check className="mr-2 h-4 w-4" />确认并用于这里</Button><Button variant="secondary" onClick={() => setImageDraft(undefined)}>不要这张</Button></div>
          </div>}
        </Panel></ToolDisclosure>}

        <ToolDisclosure title="声音" icon={Music} hint={audioStatus ? audioStatusLabel(audioStatus) : "本地音量与氛围音频"}>
        <Panel className="grid gap-3 p-4">
          <div className="flex items-center gap-2"><Music className="h-4 w-4 text-brass" /><h2 className="text-sm font-semibold">同步氛围音频</h2></div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label={audioMuted ? "取消静音" : "静音"}
              className="rounded p-2 text-zinc-400 hover:bg-zinc-800"
              onClick={() => setAudioMuted((value) => !value)}
            >
              {audioMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </button>
            <input aria-label="本地音量" type="range" min="0" max="1" step="0.05" value={localAudioVolume} onChange={(event) => setLocalAudioVolume(Number(event.target.value))} className="min-w-0 flex-1" />
            <span className="w-9 text-right text-[11px] text-zinc-500">{Math.round(localAudioVolume * 100)}%</span>
          </div>
          {audioStatus && <p className="text-[11px] text-zinc-500">本机：{audioStatusLabel(audioStatus)}</p>}
          {!readOnly && session?.isHost && <div className="grid gap-3 border-t border-zinc-800 pt-3">
            <Field label="这段声音叫什么" hint="玩家等待接收和播放时会看到这个名字。"><Input value={audioTitle} maxLength={160} disabled={audioOperation !== "idle"} onChange={(event) => setAudioTitle(event.target.value)} placeholder="例如：雨夜的剧院走廊" /></Field>
            <Button variant="secondary" disabled={!hasManagedAssetStore() || audioOperation !== "idle"} onClick={() => void prepareRoomAudio()}>{audioOperation === "selecting" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Music className="mr-2 h-4 w-4" />}{audioOperation === "selecting" ? "正在准备声音…" : "选择音频并发送给玩家"}</Button>
            <p className="text-[11px] leading-4 text-zinc-600">先让大家接收音频，准备好后再播放。网络较慢的玩家不会阻塞聊天和剧情推进。</p>
            {selectedAudio && <div role="status" className="rounded-lg border border-zinc-800 bg-zinc-950 p-3"><p className="text-xs font-medium text-zinc-200">已准备：{selectedAudioTitle}</p><p className="mt-1 text-[11px] text-zinc-600">{audioAssetSummary(selectedAudio)}</p></div>}
            {audioOperation === "waiting" && <div role="status" className="rounded-lg border border-amber-900/60 bg-amber-950/15 p-3"><p className="text-xs font-medium text-amber-100"><Loader2 className="mr-2 inline h-3.5 w-3.5 animate-spin" />正在等待在线玩家接收完成…</p><p className="mt-1 text-[11px] leading-5 text-zinc-500">最多等待 30 秒；聊天和剧情仍可继续。取消后不会开始这次播放。</p><Button className="mt-2 h-8 text-xs" variant="secondary" onClick={cancelAudioWait}>取消这次播放</Button></div>}
            <label className="flex items-center gap-2 text-xs text-zinc-400"><input type="checkbox" disabled={audioOperation !== "idle"} checked={audioLoop} onChange={(event) => setAudioLoop(event.target.checked)} />循环播放</label>
            <div className="grid grid-cols-2 gap-2">
              <Field label="建议音量"><Input disabled={audioOperation !== "idle"} type="number" min={0} max={1} step={0.05} value={audioVolume} onChange={(event) => setAudioVolume(clampAudio(Number(event.target.value), 0, 1))} /></Field>
              <Field label="从第几秒开始"><Input disabled={audioOperation !== "idle"} type="number" min={0} max={86_400} step={0.5} value={audioStartOffsetMs / 1_000} onChange={(event) => setAudioStartOffsetMs(Math.trunc(clampAudio(Number(event.target.value) * 1_000, 0, 86_400_000)))} /></Field>
              <Field label="淡入秒数"><Input disabled={audioOperation !== "idle"} type="number" min={0} max={60} step={0.5} value={audioFadeInMs / 1_000} onChange={(event) => setAudioFadeInMs(Math.trunc(clampAudio(Number(event.target.value) * 1_000, 0, 60_000)))} /></Field>
              <Field label="淡出秒数"><Input disabled={audioOperation !== "idle"} type="number" min={0} max={60} step={0.5} value={audioFadeOutMs / 1_000} onChange={(event) => setAudioFadeOutMs(Math.trunc(clampAudio(Number(event.target.value) * 1_000, 0, 60_000)))} /></Field>
            </div>
            <div className="flex gap-2">
              <Button disabled={!selectedAudio || audioOperation !== "idle"} onClick={() => void cueRoomAudio()}>{audioOperation === "starting" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Music className="mr-2 h-4 w-4" />}{audioOperation === "starting" ? "正在开始…" : "播放"}</Button>
              <Button variant="secondary" disabled={world.activeAudio.size === 0 || audioOperation !== "idle"} onClick={() => void stopRoomAudio()}><Square className="mr-2 h-3.5 w-3.5" />{audioOperation === "stopping" ? "正在停止…" : "停止"}</Button>
            </div>
          </div>}
        </Panel></ToolDisclosure>

        {!readOnly && <ToolDisclosure title="临时补充内容" icon={Wrench} hint="模组里没有时再使用">
        <Panel className="grid gap-3 p-4">
          <h2 className="text-sm font-semibold">临时创建一项内容</h2>
          <select aria-label="内容类型" className="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm" value={session?.isHost ? entityKind : "clue"} onChange={(event) => setEntityKind(event.target.value as typeof entityKind)}>{session?.isHost && <><option value="location">地点</option><option value="npc">人物</option></>}<option value="clue">线索</option></select>
          <Field label="名称"><Input value={entityName} onChange={(event) => setEntityName(event.target.value)} /></Field>
          <Field label={entityKind === "clue" ? "线索正文" : "玩家会看到的描述"}><Textarea value={entityDescription} onChange={(event) => setEntityDescription(event.target.value)} placeholder="KP 私密资料不要放在这里" /></Field>
          <label className="flex items-center gap-2 text-xs text-zinc-400"><input type="checkbox" checked={secretDraft} onChange={(event) => setSecretDraft(event.target.checked)} />只给我和 KP 看</label>
          {session?.isHost && entityKind !== "clue" && activeScene && <label className="flex items-start gap-2 rounded-md border border-brass/20 bg-brass/5 p-3 text-xs leading-5 text-zinc-300"><input className="mt-1" type="checkbox" checked={presentNewEntityInActiveScene} onChange={(event) => setPresentNewEntityInActiveScene(event.target.checked)} />创建后立即在当前情境“{activeScene.name}”登场</label>}
          {session?.isHost && entityKind !== "clue" && !activeScene && <p className="rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs leading-5 text-zinc-500">当前还没有情境。内容会保留在下方；KP 开场后可点“让它在当前情境登场”。</p>}
          <Button disabled={commandsDisabled || !entityName.trim() || (entityKind === "clue" && !entityDescription.trim())} onClick={() => void createEntity()}>{entityKind === "clue" ? (secretDraft ? "保存私密线索" : "公开到调查案卷") : activeScene && presentNewEntityInActiveScene ? "创建并在当前情境登场" : "创建这项内容"}</Button>
          <div className="grid gap-2">{[...world.entities.values()].map((entity) => {
            const canPresentHere = Boolean(session?.isHost && activeScene && (entity.kind === "location" || entity.kind === "npc"));
            const presentedHere = Boolean(activeScene && entityPresentedInScene(entity, activeScene.entityId));
            return <div key={entity.entityId} className="rounded-md bg-zinc-950 p-3"><div className="flex items-center justify-between"><div><b className="text-sm">{entity.name}</b><span className="ml-2 text-[10px] text-zinc-600">{roomEntityKindLabel(entity.kind)}</span></div><div className="flex flex-wrap justify-end gap-2">{canPresentHere && (presentedHere ? <span className="text-[10px] text-emerald-400">已在当前情境</span> : <button className="text-xs text-brass hover:underline" onClick={() => void presentEntityInActiveScene(entity)}>让它在当前情境登场</button>)}{board && (session?.isHost || (board.kind === "evidence" && entity.kind === "clue")) && isAudienceSubsetV2(board.audience, entity.audience) && <button className="text-xs text-brass hover:underline" onClick={() => void placeEntity(entity)}>放到当前画面</button>}{entity.kind === "npc" && session?.isHost && <button className="text-xs text-brass hover:underline" onClick={() => setPendingNpcSessionEntityId(entity.entityId)}>开始交谈</button>}</div></div><p className="mt-1 line-clamp-3 text-xs leading-5 text-zinc-500">{entity.description}</p></div>;
          })}</div>
        </Panel></ToolDisclosure>}

        {world.npcSessions.size > 0 && <ToolDisclosure
          title={session?.isHost ? "NPC 扮演助手" : "与 NPC 交谈"}
          icon={UserRound}
          hint={activeNpcSession?.title ?? `${world.npcSessions.size} 段交谈`}
          detailsRef={npcConversationDetailsRef}
        >
        <Panel className="grid gap-3 p-4">
          <div className="flex items-start gap-2">
            <UserRound className="mt-0.5 h-4 w-4 shrink-0 text-brass" />
            <div>
              <h2 className="text-sm font-semibold">{session?.isHost ? "NPC 扮演助手" : "与 NPC 交谈"}</h2>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                {session?.isHost ? "在独立对话里扮演 NPC，或让助手先起草回应。" : "这里的交谈与大厅聊天分开记录。"}
              </p>
            </div>
          </div>
          <label className="grid gap-1.5 text-xs text-zinc-400">
            <span>选择对话</span>
            <select
              aria-label="选择 NPC 对话"
              className="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-200"
              value={activeNpcSession?.sessionId ?? ""}
              onChange={(event) => setActiveNpcSessionId(event.target.value)}
            >
              <option value="" disabled>选择一段交谈</option>
              {npcSessionsNewestFirst.map((npcSession) => <option key={npcSession.sessionId} value={npcSession.sessionId}>{npcSession.title}{npcSession.status === "paused" ? "（已暂停）" : npcSession.status === "closed" ? "（已结束）" : ""}</option>)}
            </select>
          </label>
          {activeNpcSession && <>
            <section aria-label="当前 NPC 对话" className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-zinc-100">{activeNpcSession.title}</h3>
                {activeNpcSession.status !== "active" && <span className="rounded-full bg-zinc-800 px-2 py-1 text-[10px] text-zinc-400">
                  {activeNpcSession.status === "paused" ? "交谈已暂停" : "交谈已结束"}
                </span>}
              </div>
              <p className="mt-1 text-[11px] text-zinc-500">{npcSessionAudienceLabelV2(activeNpcSession.audience, seats)}</p>
              {session?.isHost && activeNpcSession.description && <p className="mt-1 text-xs leading-5 text-zinc-500">{activeNpcSession.description}</p>}
              {activeNpcSession.endedAt && <p className="mt-1 text-[11px] text-zinc-600">结束于 {new Date(activeNpcSession.endedAt).toLocaleString()}</p>}
            </section>

            {session?.isHost && !readOnly && <section aria-label="NPC 交谈管理" className="grid gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
              <div>
                <p className="text-xs font-medium text-zinc-300">交谈状态</p>
                <p className="mt-1 text-[11px] leading-5 text-zinc-600">暂停后可以恢复；结束后这段记录只读，需要为新的参与者另开一段交谈。</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {activeNpcSession.status === "active" && <Button variant="secondary" onClick={() => void pauseNpcSession()}>暂停交谈</Button>}
                {activeNpcSession.status === "paused" && <Button onClick={() => void resumeNpcSession()}>恢复交谈</Button>}
                {activeNpcSession.status !== "closed" && <Button variant="secondary" onClick={() => void endNpcSession()}>结束交谈</Button>}
                {activeNpcEntity?.kind === "npc" && <Button variant={activeNpcSession.status === "closed" ? "primary" : "ghost"} onClick={() => setPendingNpcSessionEntityId(activeNpcEntity.entityId)}>另开新交谈</Button>}
              </div>
            </section>}

            {session?.isHost && !readOnly && activeNpcSession.status === "active" && <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
              <div>
                <p className="text-xs font-medium text-zinc-300">{activeNpcSession.autoReply && activeNpcSession.status === "active" ? "助手正在等待调查员发言" : "当前由 KP 手动回应"}</p>
                <p className="mt-1 text-[11px] text-zinc-600">所有自动回应都可以立即停止。</p>
              </div>
              <div className="flex gap-2">
                <Button disabled={activeNpcSession.autoReply && activeNpcSession.status === "active"} onClick={() => void updateNpcSession((current) => {
                  const { endedAt: _endedAt, ...withoutEnd } = current;
                  return { ...withoutEnd, revision: current.revision + 1, status: "active", autoReply: true };
                })}>开启扮演助手</Button>
                <Button variant="secondary" disabled={!activeNpcSession.autoReply || activeNpcSession.status !== "active"} onClick={() => void stopNpcAutomation(activeNpcSession)}>立即停止</Button>
              </div>
            </div>}

            {session?.isHost && activeNpcShadowReplies.map((shadow) => <div key={shadow.jobId} className="grid gap-2 rounded-md border border-amber-800/60 bg-amber-950/20 p-3 text-xs">
              <p className="font-semibold text-amber-200">待 KP 审核的 NPC 回应</p>
              <p className="whitespace-pre-wrap text-zinc-300">{shadow.reply.spokenText}</p>
              {shadow.reply.stageDirection && <p className="text-zinc-500">动作：{shadow.reply.stageDirection}</p>}
              <div className="flex gap-2"><Button disabled={activeNpcSession.status !== "active"} onClick={() => void publishNpcShadow(shadow)}>确认并说出</Button><Button variant="secondary" onClick={() => onDismissNpcShadow?.(shadow.jobId)}>丢弃</Button></div>
            </div>)}

            <div aria-label="NPC 对话记录" className="max-h-72 space-y-2 overflow-y-auto rounded-lg bg-zinc-950/50 p-2">
              {(world.npcMessages.get(activeNpcSession.sessionId) ?? []).length === 0 && <p className="px-2 py-6 text-center text-xs leading-5 text-zinc-600">还没有人开口。你可以从一句问候或一个问题开始。</p>}
              {(world.npcMessages.get(activeNpcSession.sessionId) ?? []).map((item) => <div key={item.messageId} className="rounded bg-zinc-900/70 p-2 text-xs"><b>{npcPanelSpeakerLabelV2(item, activeNpcEntity?.name, seats, world.latestCharacters)}</b><p className="mt-1 whitespace-pre-wrap leading-5 text-zinc-400">{item.spokenText}</p></div>)}
            </div>
            {!readOnly && activeNpcSession.status === "active" && <label className="grid gap-1.5 text-xs text-zinc-400">
              <span>{session?.isHost ? "输入调查员发言或 NPC 回应" : `你想对${activeNpcEntity ? ` ${activeNpcEntity.name}` : " NPC"}说什么？`}</span>
              <Textarea aria-label="NPC 对话输入" value={npcMessage} onChange={(event) => setNpcMessage(event.target.value)} placeholder="只会发送到这段交谈" />
            </label>}
            {!readOnly && activeNpcSession.status !== "active" && <p role="status" className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 text-xs leading-5 text-zinc-500">{activeNpcSession.status === "paused" ? "KP 已暂停这段交谈。恢复后才能继续发言。" : "这段交谈已经结束，只能回看记录；需要继续时请另开一段交谈。"}</p>}
            {!readOnly && activeNpcSession.status === "active" && <div className="flex gap-2">
              <Button disabled={commandsDisabled || !npcMessage.trim()} onClick={() => void sendNpcPanelMessage("human")}>{session?.isHost ? `以 ${session.localSeat.displayName} 身份发言` : "发送"}</Button>
              {session?.isHost && <Button variant="secondary" disabled={!npcMessage.trim()} onClick={() => void sendNpcPanelMessage("npc")}>以 NPC 身份回应</Button>}
            </div>}

            {session?.isHost && <details className="rounded-lg border border-zinc-800 bg-zinc-950/30 px-3 py-2 text-xs">
              <summary className="cursor-pointer font-medium text-zinc-400 hover:text-zinc-200">上下文与安全边界</summary>
              <div className="mt-3 grid gap-3 border-t border-zinc-800 pt-3">
                <p className="leading-5 text-zinc-500">每次回应会读取当前 NPC 卡、KP 挂载的资料（最多 64 条）和本对话最近的消息。不会读取大厅聊天、其他对话、完整模组、主持人笔记或本机文件。</p>
                <div>
                  <p className="mb-2 text-xs text-zinc-400">已挂载资料 · {activeNpcSession.pinnedContext.length}/64</p>
                  {activeNpcSession.pinnedContext.length === 0 && <p className="rounded bg-zinc-950 p-2 text-zinc-600">尚未挂载额外资料；助手只会参考 NPC 卡和本对话。</p>}
                  <div className="grid gap-1">{activeNpcSession.pinnedContext.map((pin) => <div key={pin.pinId} className="flex items-start justify-between gap-2 rounded bg-zinc-950 p-2 text-xs"><div><b>{pin.title}</b><p className="mt-1 line-clamp-2 text-zinc-500">{pin.body}</p></div>{!readOnly && activeNpcSession.status !== "closed" && <button className="shrink-0 text-red-300 hover:underline" onClick={() => void updateNpcSession((current) => ({ ...current, revision: current.revision + 1, pinnedContext: current.pinnedContext.filter((item) => item.pinId !== pin.pinId) }))}>移除</button>}</div>)}</div>
                  {!readOnly && activeNpcSession.status !== "closed" && <>
                    <Input className="mt-2" value={npcPinTitle} maxLength={240} onChange={(event) => setNpcPinTitle(event.target.value)} placeholder="资料标题" />
                    <Textarea className="mt-2" value={npcPinBody} maxLength={100_000} onChange={(event) => setNpcPinBody(event.target.value)} placeholder="只有这里的正文会进入 NPC 上下文" />
                    <Button className="mt-2" variant="secondary" disabled={!npcPinTitle.trim() || !npcPinBody.trim() || activeNpcSession.pinnedContext.length >= 64} onClick={() => void addNpcPin()}>挂载到这段交谈</Button>
                  </>}
                </div>
              </div>
            </details>}

            {session?.isHost && <details className="rounded-lg border border-zinc-800 bg-zinc-950/30 px-3 py-2 text-xs">
              <summary className="cursor-pointer font-medium text-zinc-400 hover:text-zinc-200">高级设置</summary>
              <div className="mt-3 grid gap-3 border-t border-zinc-800 pt-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Field label="AI 提供者"><select disabled={readOnly || activeNpcSession.status === "closed"} className="h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm" value={activeNpcSession.provider} onChange={(event) => void updateNpcSession((current) => ({ ...current, revision: current.revision + 1, provider: event.target.value as "codex" | "deepseek" }))}><option value="codex">Codex</option><option value="deepseek">DeepSeek</option></select></Field>
                  <Field label="发布方式"><select disabled={readOnly || activeNpcSession.status === "closed"} className="h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm" value={activeNpcSession.mode} onChange={(event) => void updateNpcSession((current) => ({ ...current, revision: current.revision + 1, mode: event.target.value as "shadow" | "autonomous" }))}><option value="shadow">先由 KP 审核</option><option value="autonomous">自动发布</option></select></Field>
                </div>
                <p className="leading-5 text-zinc-600">“先由 KP 审核”会把草稿留在 KP 本机，确认后才让 NPC 说出；自动发布让 NPC 直接开口，仍可随时停止。</p>
                {activeNpcStatuses.length > 0 && <div className="grid gap-1">{activeNpcStatuses.slice(-3).map((status) => <p key={status.jobId} className={`rounded px-2 py-1 text-[11px] ${status.status === "failed" ? "bg-red-950/30 text-red-300" : status.status === "running" || status.status === "queued" ? "bg-amber-950/30 text-amber-200" : "bg-zinc-950 text-zinc-500"}`}>{status.message}</p>)}</div>}
              </div>
            </details>}
          </>}
        </Panel></ToolDisclosure>}

        <details className="mt-2 rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-600">
          <summary className="cursor-pointer hover:text-zinc-400">连接与隐私详情</summary>
          <p className="mt-2 leading-5">本机已保存 {visibleEvents.length} 条你有权查看的记录。另有 {views.length - visibleEvents.length} 个不可见的顺序标记，用来在重连后继续补齐；其中没有正文、内容类别或附件信息。</p>
        </details>
      </aside>
      {session?.isHost && !readOnly && pendingNpcSessionEntity?.kind === "npc" && <NpcSessionStartDialogV2
        npc={pendingNpcSessionEntity}
        seats={seats}
        busy={npcSessionCreating}
        onCancel={() => setPendingNpcSessionEntityId(undefined)}
        onConfirm={startNpcSession}
      />}
    </div>
  );
}

function readSeenPublicMaterialSequence(storageKey: string): number {
  try {
    const value = globalThis.sessionStorage?.getItem(storageKey);
    if (!value) return 0;
    const sequence = Number.parseInt(value, 10);
    return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0;
  } catch {
    return 0;
  }
}

function writeSeenPublicMaterialSequence(storageKey: string, sequence: number): void {
  try {
    globalThis.sessionStorage?.setItem(storageKey, String(sequence));
  } catch {
    // The notice remains useful for this render even when private browsing blocks storage.
  }
}

function ZeroSceneModuleRecoveryV2({
  moduleTitle,
  onManual,
  onRepair,
  compact = false,
}: {
  readonly moduleTitle: string;
  readonly onManual: () => void;
  readonly onRepair: () => void;
  readonly compact?: boolean;
}) {
  return <section
    aria-label="零场景模组恢复"
    className={`${compact ? "rounded-lg" : "border-t"} border-amber-900/60 bg-amber-950/15 p-4`}
  >
    <p className="text-sm font-medium text-amber-100">《{moduleTitle}》暂时没有可呈现的场景</p>
    <p className="mt-1 text-xs leading-5 text-zinc-500">临时开场只会公开你手动填写的标题和描述，不会自动读取或发布模组中的其他资料。</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <Button className="h-8 text-xs" onClick={onManual}><Clapperboard className="mr-2 h-3.5 w-3.5" />临时开场</Button>
      <Button className="h-8 text-xs" variant="secondary" onClick={onRepair}><FolderKanban className="mr-2 h-3.5 w-3.5" />返回模组库修复</Button>
    </div>
  </section>;
}

function ToolDisclosure({
  title,
  icon: Icon,
  hint,
  detailsRef,
  children,
}: {
  title: string;
  icon: typeof Wrench;
  hint?: string;
  detailsRef?: RefObject<HTMLDetailsElement>;
  children: React.ReactNode;
}) {
  return <details ref={detailsRef} className="group mb-3 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/50">
    <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-zinc-900/70">
      <Icon className="h-4 w-4 shrink-0 text-zinc-500 group-open:text-brass" />
      <span className="min-w-0 flex-1 text-sm font-medium text-zinc-300">{title}</span>
      {hint && <span className="truncate text-[10px] text-zinc-600">{hint}</span>}
      <span aria-hidden="true" className="text-zinc-600 transition group-open:rotate-45">＋</span>
    </summary>
    <div className="border-t border-zinc-800 p-2">{children}</div>
  </details>;
}

function PlayerCheckHandoffBanner({
  readyAuthorization,
  readyRequest,
  closure,
  compact = false,
  onOpenAction,
  onAcknowledgeClosure,
}: {
  readyAuthorization?: CheckAuthorizationV2;
  readyRequest?: CheckRequestV2;
  closure?: Extract<RoomEventV2, { type: "check.closed" }>;
  compact?: boolean;
  onOpenAction(): void;
  onAcknowledgeClosure(eventId: string): void;
}) {
  const readyIsPush = readyRequest?.pushOfRequestId !== undefined;
  return <section
    role="status"
    aria-live="polite"
    aria-label={compact ? "工具中的玩家裁定交接" : "玩家裁定交接"}
    className={compact
      ? "mb-4 grid gap-3 rounded-xl border border-amber-800/60 bg-amber-950/20 p-3"
      : "grid gap-3 border-b border-amber-900/60 bg-amber-950/20 px-4 py-3 sm:px-5"}
  >
    <div className={compact ? "grid gap-3" : "mx-auto grid w-full max-w-4xl gap-3"}>
      {readyAuthorization && readyRequest && <article className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-sm font-semibold text-amber-100">{readyIsPush ? "KP 已说明强推代价" : "KP 已允许这次检定"}</h2>
          <p className="mt-1 text-xs leading-5 text-zinc-400">{readyRequest.characterName} · {readyAuthorization.skillName ?? readyRequest.skillName} {readyAuthorization.target}{readyIsPush ? "；先读清再次失败的后果，再决定是否承担。" : "；检定参数已经确定，可以掷骰。"}</p>
        </div>
        <Button className="shrink-0" onClick={onOpenAction}>{readyIsPush ? "查看代价并决定" : "回到现场掷骰"}</Button>
      </article>}
      {closure && <article className={`flex flex-col justify-between gap-3 sm:flex-row sm:items-center ${readyAuthorization && readyRequest ? "border-t border-amber-900/50 pt-3" : ""}`}>
        <div>
          <h2 className="text-sm font-semibold text-amber-100">{closure.payload.outcome === "no-roll" ? "这项行动无需掷骰" : "KP 判断这项做法当前不可行"}</h2>
          <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-zinc-300">{closure.payload.note || (closure.payload.outcome === "no-roll" ? "KP 会直接按叙事推进。" : "可以换一种做法继续调查。")}</p>
        </div>
        <Button className="shrink-0" variant="secondary" onClick={() => onAcknowledgeClosure(closure.eventId)}>知道了，继续</Button>
      </article>}
    </div>
  </section>;
}

function SceneNpcCard({
  entity,
  artifacts,
  resolveAsset,
  conversation,
  isHost,
  readOnly,
  onStart,
  onOpen,
}: {
  entity: RoomEntityV2;
  artifacts: ReadonlyMap<string, RoomArtifactV2>;
  resolveAsset?: (asset: AssetDescriptorV1) => Promise<string>;
  conversation?: NpcInteractionSessionV1;
  isHost: boolean;
  readOnly: boolean;
  onStart(): void;
  onOpen(sessionId: string): void;
}) {
  const actionLabel = conversation?.status === "active"
    ? isHost ? "打开交谈" : "进入交谈"
    : "查看交谈";
  return <article className="rounded-lg bg-black/20 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <b className="text-sm text-zinc-100">{entity.name}</b>
      {!readOnly && <div className="flex flex-wrap justify-end gap-2">
        {conversation && <button type="button" className="text-xs font-medium text-brass hover:underline" aria-label={`${actionLabel}：${entity.name}`} onClick={() => onOpen(conversation.sessionId)}>{actionLabel}</button>}
        {isHost && <button type="button" className="text-xs font-medium text-brass hover:underline" aria-label={`${conversation ? "另开交谈" : "开启交谈"}：${entity.name}`} onClick={onStart}>{conversation ? "另开交谈" : "开启交谈"}</button>}
      </div>}
    </div>
    {entity.description && <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-zinc-400">{entity.description}</p>}
    <VisibleEntityArtifactMediaV2 entity={entity} artifacts={artifacts} resolveAsset={resolveAsset} />
    {conversation?.status === "paused" && <p className="mt-2 text-[10px] text-zinc-600">这段交谈已暂停，仍可打开查看。</p>}
    {conversation?.status === "closed" && <p className="mt-2 text-[10px] text-zinc-600">这段交谈已经结束，仍可回看记录。</p>}
  </article>;
}

function findNpcConversation(world: RoomWorldStateV2, npcEntityId: string): NpcInteractionSessionV1 | undefined {
  const conversations = [...world.npcSessions.values()].filter((conversation) => conversation.npcEntityId === npcEntityId).reverse();
  return conversations.find(({ status }) => status === "active") ?? conversations[0];
}

function isHumanRecordEvent(event: RoomEventV2): boolean {
  switch (event.type) {
    case "board.created":
    case "board.updated":
    case "board.activated":
    case "board.item.upserted":
    case "board.item.removed":
    case "board.edge.upserted":
    case "board.edge.removed":
    case "board.fog.revealed":
    case "audience.expanded":
    case "room.settings.updated":
      return false;
    default:
      return true;
  }
}

function humanRecordCategory(event: RoomEventV2): Exclude<HumanRecordCategory, "all"> {
  switch (event.type) {
    case "chat.message":
    case "npc.session.message":
      return "dialogue";
    case "dice.result":
    case "check.requested":
    case "check.authorized":
    case "check.closed":
    case "check.outcome.described":
      return "checks";
    case "scene.focused":
    case "artifact.upserted":
    case "clue.claimed":
    case "clue.unclaimed":
      return "discoveries";
    case "entity.upserted":
      return event.payload.entity.kind === "character" ? "status" : "discoveries";
    default:
      return "status";
  }
}

function matchesHumanRecordQuery(event: RoomEventV2, query: string, world: RoomWorldStateV2): boolean {
  const terms = normalizeRecordSearch(query).split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return true;
  const searchable = normalizeRecordSearch(humanRecordSearchText(event, world));
  return terms.every((term) => searchable.includes(term));
}

function humanRecordSearchText(event: RoomEventV2, world: RoomWorldStateV2): string {
  const parts: string[] = [event.sender.displayName];
  const appendCheckRequest = (requestId: string | undefined) => {
    if (!requestId) return;
    const request = world.checkRequests.get(requestId);
    if (request) parts.push(request.characterName, request.goal ?? "", request.approach ?? request.reason, request.suggestedSkillName ?? request.skillName);
  };
  switch (event.type) {
    case "chat.message":
    case "system.notice":
      parts.push(event.payload.message);
      break;
    case "dice.result":
      parts.push("检定", event.payload.reason, event.payload.result.expression, String(event.payload.result.total));
      appendCheckRequest(event.payload.checkRequestId);
      break;
    case "character.updated":
      parts.push("角色 状态 调查员", event.payload.character.name, event.payload.character.playerName, event.payload.character.occupation);
      break;
    case "check.requested":
      parts.push("检定 行动 目标 做法", event.payload.characterName, event.payload.goal ?? "", event.payload.approach ?? event.payload.reason, event.payload.suggestedSkillName ?? event.payload.skillName, String(event.payload.proposedTarget ?? ""));
      break;
    case "check.authorized":
      parts.push("检定", event.payload.skillName ?? "", difficultyLabel(event.payload.requiredDifficulty), String(event.payload.target), event.payload.note);
      appendCheckRequest(event.payload.requestId);
      break;
    case "check.closed":
      parts.push("检定", event.payload.outcome, event.payload.note);
      appendCheckRequest(event.payload.requestId);
      break;
    case "check.outcome.described":
      parts.push("检定 结果 后果 叙述", event.payload.text);
      appendCheckRequest(event.payload.requestId);
      break;
    case "clue.claimed":
    case "clue.unclaimed": {
      parts.push("发现 线索 重点", event.payload.characterName);
      const artifact = world.artifacts.get(event.payload.artifactId);
      if (artifact) parts.push(artifact.title, artifact.body);
      break;
    }
    case "module.switched":
      parts.push("模组 状态", event.payload.title);
      break;
    case "scene.focused": {
      parts.push("发现 场景");
      const scene = world.entities.get(event.payload.sceneEntityId);
      if (scene) parts.push(scene.name, scene.description);
      break;
    }
    case "entity.upserted":
      parts.push("发现", roomEntityKindLabel(event.payload.entity.kind), event.payload.entity.name, event.payload.entity.description);
      break;
    case "artifact.upserted":
      parts.push("发现", artifactKindSearchLabel(event.payload.artifact.kind), event.payload.artifact.title, event.payload.artifact.description, event.payload.artifact.body);
      break;
    case "npc.session.upserted": {
      parts.push("人物 状态 交谈", event.payload.session.title, event.payload.session.description);
      const npc = world.entities.get(event.payload.session.npcEntityId);
      if (npc) parts.push(npc.name, npc.description);
      break;
    }
    case "npc.session.message": {
      parts.push("对话 发言", event.payload.spokenText);
      const conversation = world.npcSessions.get(event.payload.sessionId);
      if (conversation) {
        parts.push(conversation.title);
        const npc = world.entities.get(conversation.npcEntityId);
        if (npc) parts.push(npc.name);
      }
      break;
    }
    case "audio.cued":
      parts.push("音频 状态 播放", event.payload.loop ? "循环" : "");
      break;
    case "audio.stopped":
      parts.push("音频 状态 停止");
      break;
    default:
      break;
  }
  return parts.filter(Boolean).join(" ");
}

function normalizeRecordSearch(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function artifactKindSearchLabel(kind: RoomArtifactV2["kind"]): string {
  switch (kind) {
    case "document": return "文档";
    case "clue": return "线索";
    case "handout": return "手记";
    case "note": return "笔记";
    case "image": return "图片";
    case "file": return "文件";
    case "map-background": return "地图 背景";
    case "location-background": return "地点 背景";
    case "npc-portrait": return "人物 肖像";
    case "handout-image": return "手记 图片";
    case "ambience-audio": return "氛围 音频";
    case "other": return "其他";
  }
}

function isLiveStoryEvent(event: RoomEventV2): boolean {
  switch (event.type) {
    case "chat.message":
    case "system.notice":
    case "dice.result":
    case "check.requested":
    case "check.authorized":
    case "check.closed":
    case "check.outcome.described":
    case "scene.focused":
    case "entity.upserted":
    case "artifact.upserted":
    case "npc.session.message":
      return true;
    default:
      return false;
  }
}

function isCaseFileArtifactKind(kind: RoomArtifactV2["kind"]): boolean {
  return kind === "clue" || kind === "handout" || kind === "note";
}

function V2EventCard({
  event,
  resolveAsset,
}: {
  event: RoomEventV2;
  resolveAsset?: (asset: AssetDescriptorV1) => Promise<string>;
}) {
  return <article className="rounded-xl border border-zinc-800/80 bg-zinc-900/55 px-4 py-3"><header className="mb-1.5 flex items-center gap-2 text-xs text-zinc-500"><span className="font-medium text-zinc-300">{event.sender.displayName}</span><time>{new Date(event.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></header><div className="text-sm leading-6 text-ink">{eventBody(event, resolveAsset)}</div></article>;
}

function RoomErrorNoticeV2({ error, onDismiss }: { error: string; onDismiss(): void }) {
  const readable = humanRoomError(error);
  return <div role="alert" className="flex items-start justify-between gap-3 border-b border-amber-900 bg-amber-950/30 px-5 py-3 text-xs text-amber-200">
    <div>
      <p>{readable}</p>
      {readable !== error && <details className="mt-2 text-amber-200/70"><summary className="cursor-pointer">查看失败原因</summary><p className="mt-1 break-words">{error}</p></details>}
    </div>
    <button type="button" className="shrink-0 rounded p-1 hover:bg-amber-900/40" aria-label="关闭错误提示" onClick={onDismiss}><X className="h-3.5 w-3.5" /></button>
  </div>;
}

function humanRoomError(error: string): string {
  if (/revision|conflict|CONFLICT/i.test(error)) return "有人刚刚修改了这项内容。请重新打开后再试。";
  if (/forbidden|unauthori[sz]ed|authentication|FORBIDDEN/i.test(error)) return "当前身份不能完成这项操作。请确认已经用自己的邀请重新加入房间。";
  if (/relay|websocket|network|fetch|ice|timeout|timed out/i.test(error)) return "房间连接暂时不稳定，这次操作没有发出。请稍等片刻再试。";
  if (/[㐀-鿿]/u.test(error)) return error;
  return "刚才的操作没有完成。已经保存的记录不会受到影响，请稍后再试。";
}

function eventBody(
  event: RoomEventV2,
  resolveAsset?: (asset: AssetDescriptorV1) => Promise<string>,
): React.ReactNode {
  switch (event.type) {
    case "chat.message": return <p className="whitespace-pre-wrap">{event.payload.message}</p>;
    case "system.notice": return <p>{event.payload.message}</p>;
    case "dice.result": return <p><b className="text-brass">{event.payload.result.total}</b><span className="ml-2 text-zinc-400">{event.payload.reason || event.payload.result.expression}</span>{event.payload.result.kind === "percentile" && event.payload.result.check && <span className={event.payload.result.check.success ? "ml-2 text-emerald-300" : "ml-2 text-red-300"}>{checkOutcomeLabel(event.payload.result.check.outcome)} · {event.payload.result.check.success ? "通过" : "未通过"}</span>}</p>;
    case "character.updated": return <p>更新角色卡：<b>{event.payload.character.name}</b></p>;
    case "check.requested": return <div><p><b>{event.payload.characterName}</b> 提交行动：{event.payload.goal ?? event.payload.reason}</p><p className="mt-1 text-zinc-400">做法：{event.payload.approach ?? event.payload.reason}{event.payload.suggestedSkillName ? ` · 建议 ${event.payload.suggestedSkillName}${event.payload.proposedTarget ? ` ${event.payload.proposedTarget}` : ""}` : ""}</p></div>;
    case "check.authorized": return <p>KP 允许检定：{event.payload.skillName ? <><b>{event.payload.skillName}</b> · </> : null}目标 <b>{event.payload.target}</b> · {difficultyLabel(event.payload.requiredDifficulty)}</p>;
    case "check.closed": return <p>{event.payload.outcome === "no-roll" ? "KP 判断无需掷骰，直接推进" : event.payload.outcome === "declined" ? "KP 判断这项行动当前不可行" : "调查员撤回了行动申请"}{event.payload.note ? `：${event.payload.note}` : ""}</p>;
    case "check.outcome.described": return <div><p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-400">本次行动的叙述结果</p><p className="mt-1 whitespace-pre-wrap">{event.payload.text}</p></div>;
    case "clue.claimed": return <p><b>{event.payload.characterName}</b> 将一条公开线索加入了自己的线索栏</p>;
    case "clue.unclaimed": return <p><b>{event.payload.characterName}</b> 将一条公开线索移出了自己的重点</p>;
    case "module.switched": return <p>本次调查改用模组：<b>{event.payload.title}</b></p>;
    case "room.settings.updated": return <p>房间新内容默认设为{event.payload.defaultVisibility === "public" ? "公开" : "秘密"}</p>;
    case "scene.focused": return <p>KP 推进了当前情境</p>;
    case "entity.upserted": return <div><b>{event.payload.entity.name}</b><p className="mt-1 whitespace-pre-wrap text-zinc-400">{event.payload.entity.description}</p></div>;
    case "artifact.upserted": return <div><b>{event.payload.artifact.title}</b><p className="mt-1 whitespace-pre-wrap text-zinc-400">{event.payload.artifact.body}</p><ArtifactAttachmentViewerV2 artifact={event.payload.artifact} resolveAsset={resolveAsset} compact /></div>;
    case "board.created": return <p>新建画面：<b>{event.payload.board.name}</b></p>;
    case "board.updated": return <p>调整画面：<b>{event.payload.board.name}</b></p>;
    case "board.activated": return <p>切换当前画面</p>;
    case "board.item.upserted": return <p>移动或放置：<b>{event.payload.item.label || event.payload.item.itemId}</b></p>;
    case "board.item.removed": return <p>从当前画面移除一项内容</p>;
    case "board.edge.upserted": return <p>添加关系线{event.payload.edge.label ? `：${event.payload.edge.label}` : ""}</p>;
    case "board.edge.removed": return <p>移除关系线</p>;
    case "board.fog.revealed": return <p>揭示一块迷雾区域</p>;
    case "audience.expanded": return <p>扩大一项内容的可见范围</p>;
    case "npc.session.upserted": return <p>{event.payload.session.status === "closed" ? "结束交谈" : event.payload.session.status === "paused" ? "暂停交谈" : "开始交谈"}：<b>{event.payload.session.title}</b></p>;
    case "npc.session.message": return <p><b>{event.payload.role === "npc" ? "NPC" : event.payload.role === "human" ? event.sender.displayName : "系统"}：</b>{event.payload.spokenText}</p>;
    case "audio.cued": return <p>开始播放本地音频{event.payload.loop ? "（循环）" : ""}</p>;
    case "audio.stopped": return <p>停止音频</p>;
  }
}

function draftAudience(secret: boolean, seat: SeatV2): AudienceV2 {
  if (!secret) return { kind: "room" };
  return seat.role === "host" ? { kind: "host" } : { kind: "seats", seatIds: [seat.seatId] };
}

function canSeatMoveBoardItem(
  world: RoomWorldStateV2,
  board: BoardV1,
  item: BoardItemV1,
  session: RoomSessionV2 | undefined,
): boolean {
  if (!session) return false;
  if (session.isHost) return true;
  if (item.locked) return false;
  if (board.kind === "evidence") return true;
  if (item.reference.kind !== "entity") return false;
  const entity = world.entities.get(item.reference.entityId);
  if (!entity || entity.kind !== "character") return false;
  if (typeof entity.data.ownerSeatId === "string") {
    return entity.data.ownerSeatId === session.localSeat.seatId;
  }
  if (typeof entity.data.characterId !== "string") return false;
  return world.latestCharacters.get(entity.data.characterId)?.ownerPeerId === session.localSeat.seatId;
}

function entityPresentedInScene(entity: RoomEntityV2, sceneEntityId: string): boolean {
  return Array.isArray(entity.data.presentedInSceneEntityIds)
    && entity.data.presentedInSceneEntityIds.some((value) => value === sceneEntityId);
}

function intersectionAudience(left: AudienceV2, right: AudienceV2): AudienceV2 {
  if (left.kind === "host" || right.kind === "host") return { kind: "host" };
  if (left.kind === "room") return right;
  if (right.kind === "room") return left;
  const seats = left.seatIds.filter((seatId) => right.seatIds.includes(seatId));
  return seats.length > 0 ? { kind: "seats", seatIds: seats } : { kind: "host" };
}

function pathLabel(path: ConnectionPath | undefined): string {
  if (path === "direct") return "在线";
  if (path === "relay") return "在线（备用连接）";
  if (path === "connecting") return "正在连接";
  // This helper is only called for a seat that currently has an authenticated
  // peer ID. The path callback can arrive a tick later than presence.
  return path === "offline" ? "离线" : "在线（连接方式确认中）";
}

function useManagedAssetUrl(
  asset: AssetDescriptorV1 | undefined,
  resolveAsset?: (asset: AssetDescriptorV1) => Promise<string>,
): { url?: string; state: "absent" | "loading" | "ready" | "error" } {
  const [resolved, setResolved] = useState<{
    assetId?: string;
    url?: string;
    state: "loading" | "ready" | "error";
  }>({ state: "loading" });
  useEffect(() => {
    let cancelled = false;
    setResolved({ assetId: asset?.assetId, state: "loading" });
    if (!asset || !hasManagedAssetStore()) return () => { cancelled = true; };
    void (resolveAsset ? resolveAsset(asset) : resolveManagedAssetUrl(asset.assetId)).then((next) => {
      if (!cancelled) setResolved({ assetId: asset.assetId, url: next, state: "ready" });
    }).catch(() => {
      if (!cancelled) setResolved({ assetId: asset.assetId, state: "error" });
    });
    return () => { cancelled = true; };
  }, [asset?.assetId, resolveAsset]);
  if (!asset) return { state: "absent" };
  if (!hasManagedAssetStore()) return { state: "error" };
  if (resolved.assetId !== asset.assetId) return { state: "loading" };
  return resolved;
}

function safeName(value: string): string {
  return value.replace(/[<>:"/\\|?*]/g, "_");
}

function exportFormatLabel(format: "md" | "html"): string {
  return format === "md" ? "文字记录" : "网页记录";
}

function offlineMediaExportNote(
  assets: Awaited<ReturnType<typeof prepareTranscriptAssetsV2>> | undefined,
): string {
  if (!assets || assets.length === 0) return "";
  const embedded = assets.filter(({ base64 }) => base64 !== undefined).length;
  const omitted = assets.length - embedded;
  return ` 离线媒体已嵌入 ${embedded} 个${omitted > 0 ? `，另有 ${omitted} 个在网页中标明未嵌入原因` : ""}。`;
}

function moduleImageAssets(modulePackage: ModulePackageV1 | undefined): Array<{
  asset: AssetDescriptorV1;
  label: string;
}> {
  if (!modulePackage) return [];
  try {
    const seen = new Set<string>();
    return storedCocmodContents(modulePackage).assets.flatMap((asset, index) => {
      if (!asset.mediaType.startsWith("image/") || seen.has(asset.assetId)) return [];
      seen.add(asset.assetId);
      const dimensions = asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : "";
      return [{ asset, label: `模组图片 ${index + 1}${dimensions}` }];
    });
  } catch {
    // A malformed hand-edited extension must not take down the live room. The
    // module editor remains the place to repair package metadata.
    return [];
  }
}

function defaultBoardName(kind: "scene" | "map"): string {
  switch (kind) {
    case "map": return "新的调查地图";
    case "scene": return "新的调查场景";
  }
}

function roomEntityKindLabel(kind: RoomEntityV2["kind"]): string {
  switch (kind) {
    case "location": return "地点";
    case "npc": return "人物";
    case "character": return "调查员";
    case "clue": return "线索";
    case "handout": return "手记";
    case "scene": return "场景";
    case "custom": return "其他";
  }
}

function roomImageTargetOptions(kind: CodexImageJobKind, world: RoomWorldStateV2): Array<{ value: string; label: string }> {
  if (kind === "textlessMap") {
    return [...world.boards.values()]
      .filter((board) => board.kind === "map" && !board.archived)
      .map((board) => ({ value: `board:${board.boardId}`, label: `地图“${board.name}”的背景` }));
  }
  const entityKind = kind === "location" ? "location" : kind === "npc" ? "npc" : kind === "character" ? "character" : undefined;
  if (!entityKind) return [];
  return [...world.entities.values()]
    .filter((entity) => entity.kind === entityKind)
    .map((entity) => ({ value: `entity:${entity.entityId}`, label: `${roomEntityKindLabel(entity.kind)}“${entity.name}”` }));
}

function imageTargetEmptyMessage(kind: CodexImageJobKind): string {
  if (kind === "textlessMap") return "还没有可用地图。先在现场创建一张“方位地图”，再来生成无文字底图。";
  if (kind === "npc") return "还没有已经介绍到房间的人物。先从模组导演台发布 NPC，再为他生成肖像。";
  if (kind === "character") return "还没有可用的调查员形象位置。先让玩家带入角色并把角色放进现场。";
  if (kind === "cover") return "模组封面属于备团资料，不会在房间里生成或绑定。";
  return "还没有已经公开到房间的地点。先从模组导演台发布地点，再生成它的背景图。";
}

function imageCapabilityMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (/desktop|桌面/i.test(detail)) return "图片草稿目前只能在桌面应用中生成；不影响网页跑团。";
  if (/login|auth|登录|凭据/i.test(detail)) return "Codex 尚未登录，完成登录后可生成图片；不影响其他功能。";
  return "图片生成暂不可用；不影响聊天、检定和场景推进。";
}

function formatNpcStats(values: Record<string, number>): string {
  return Object.entries(values).map(([name, value]) => `${name} ${value}`).join(" · ");
}

function difficultyLabel(value: "regular" | "hard" | "extreme") {
  return value === "regular" ? "普通" : value === "hard" ? "困难" : "极难";
}

function checkOutcomeLabel(value: "critical" | "extreme" | "hard" | "regular" | "failure" | "fumble") {
  switch (value) {
    case "critical": return "大成功";
    case "extreme": return "极难成功";
    case "hard": return "困难成功";
    case "regular": return "普通成功";
    case "failure": return "失败";
    case "fumble": return "大失败";
  }
}

function clampAudio(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function clampBoardScale(value: number): number {
  return Math.round(Math.min(3, Math.max(0.3, value)) * 10) / 10;
}

function normalizeRotation(value: number): number {
  return ((Math.round(value) % 360) + 360) % 360;
}

function audioStatusLabel(status: AudioSyncStatus): string {
  switch (status.status) {
    case "waiting": return "等待本地资源";
    case "playing": return status.loop ? "循环播放中" : "播放中";
    case "stopped": return "已停止";
    case "skipped": return `已跳过（${status.reason}）`;
    case "error": return `播放失败：${status.message}`;
  }
}

function audioAssetSummary(asset: AssetDescriptorV1): string {
  const size = asset.byteLength >= 1024 * 1024
    ? `${(asset.byteLength / (1024 * 1024)).toFixed(1)} MiB`
    : `${Math.max(1, Math.round(asset.byteLength / 1024))} KiB`;
  if (asset.durationMs === undefined) return `${size} · 时长将在本机读取后显示`;
  const totalSeconds = Math.round(asset.durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds} · ${size}`;
}
