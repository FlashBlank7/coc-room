import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { ArrowLeft, Download, Loader2, LockKeyhole, Plus, Save, Sparkles, Trash2, Upload, UserRound } from "lucide-react";
import { coc7CharacterSchema, type Coc7Character, type RoomWorldStateV2 } from "@coc-room/protocol";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { getRepository, type PersonalCharacterV2 } from "../data/repository";
import type { RoomSession } from "../network/RoomSession";
import { RoomSessionV2 } from "../network/RoomSessionV2";
import { useAppStore } from "../store/app-store";
import { deriveCoc7Stats } from "../lib/character-derivation";
import { isRoomHostAvailable } from "../lib/room-availability";
import { Button } from "../components/ui/Button";
import { Field, Input, Textarea } from "../components/ui/Field";
import { Panel } from "../components/ui/Panel";
import { createCoccharPackage, parseCoccharPackage } from "../lib/cocchar-package";
import { downloadBytesInBrowser } from "../lib/browser-download";
import {
  addManagedAssetReference,
  hasManagedAssetStore,
  importManagedAssetBytes,
  readManagedAssetChunk,
  verifyManagedAsset,
} from "../lib/asset-store";

type CharacteristicKey = keyof Coc7Character["characteristics"];
type StatusKey = keyof Coc7Character["status"];
type BackgroundKey = keyof Coc7Character["background"];
type Skill = Coc7Character["skills"][number];
type InventoryItem = Coc7Character["inventory"][number];
type CurrentResourceKey = "hitPoints" | "magicPoints" | "sanity";

const characteristicLabels: Record<CharacteristicKey, string> = {
  str: "力量 STR",
  con: "体质 CON",
  siz: "体型 SIZ",
  dex: "敏捷 DEX",
  app: "外貌 APP",
  int: "智力 INT",
  pow: "意志 POW",
  edu: "教育 EDU",
  luck: "幸运 LUCK",
};

const statusLabels: Record<StatusKey, string> = {
  temporaryInsanity: "临时性疯狂",
  indefiniteInsanity: "不定性疯狂",
  majorWound: "重伤",
  dying: "濒死",
  unconscious: "昏迷",
};

const backgroundFields: ReadonlyArray<readonly [BackgroundKey, string]> = [
  ["personalDescription", "个人描述"],
  ["ideologyAndBeliefs", "思想与信念"],
  ["significantPeople", "重要之人"],
  ["meaningfulLocations", "意义非凡之地"],
  ["treasuredPossessions", "宝贵之物"],
  ["traits", "特质"],
  ["injuriesAndScars", "伤口与疤痕"],
  ["phobiasAndManias", "恐惧症与躁狂症"],
  ["arcaneTomesSpellsAndArtifacts", "奥秘典籍、法术与神秘物品"],
  ["encountersWithStrangeEntities", "遭遇的奇异实体"],
];

const currentResourceMaximum: Record<CurrentResourceKey, keyof Coc7Character["derived"]> = {
  hitPoints: "maxHitPoints",
  magicPoints: "maxMagicPoints",
  sanity: "maxSanity",
};

type CharacterRoomSession = RoomSession | RoomSessionV2;

interface RecoverableCharacterDraftV1 {
  version: 1 | 2;
  scope: string;
  character: Coc7Character;
  privateNotes: string;
  savedAt: string;
  /** Null means the draft did not start from a room character; undefined is a legacy V1 envelope. */
  baseRoomUpdatedAt?: string | null | "unknown";
}

export interface HostCharacterDraftReview {
  jobId: string;
  requesterSeatId: string;
  requesterName: string;
  character: Coc7Character;
}

export function CharactersView({
  session,
  worldV2,
  requestCharacterDraft,
  hostCharacterDrafts = [],
  onDismissHostCharacterDraft,
}: {
  session?: CharacterRoomSession;
  worldV2?: RoomWorldStateV2;
  requestCharacterDraft?: (prompt: string, playerName: string) => Promise<Coc7Character>;
  hostCharacterDrafts?: readonly HostCharacterDraftReview[];
  onDismissHostCharacterDraft?: (jobId: string) => void;
}) {
  const events = useAppStore((state) => state.events);
  const currentRoom = useAppStore((state) => state.currentRoom);
  const participants = useAppStore((state) => state.participants);
  const paths = useAppStore((state) => state.paths);
  const sessionV2 = session instanceof RoomSessionV2 ? session : undefined;
  const sessionV1 = session && !(session instanceof RoomSessionV2) ? session : undefined;
  const personalDraftOwnerRef = useRef(globalThis.crypto.randomUUID());
  const isV2 = (currentRoom?.protocolVersion ?? 1) === 2;
  const localOwnerId = isV2
    ? currentRoom?.localSeatId ?? sessionV2?.localSeat.seatId
    : currentRoom?.localPeerId;
  const effectiveLocalOwnerId = localOwnerId ?? personalDraftOwnerRef.current;
  const draftStorageScope = characterDraftStorageScope(currentRoom?.id, localOwnerId);
  const draftStorageKey = characterDraftStorageKey(draftStorageScope);
  const displayName = sessionV2?.localSeat.displayName ?? sessionV1?.participant.displayName ?? "调查员";
  const roomCharacters = useMemo(() => {
    if (isV2) return [...(worldV2?.latestCharacters.values() ?? [])];
    const byId = new Map<string, Coc7Character>();
    for (const event of events) {
      if (event.type === "character.updated") byId.set(event.payload.character.id, event.payload.character);
    }
    return [...byId.values()];
  }, [events, isV2, worldV2]);
  const [personalCharacters, setPersonalCharacters] = useState<PersonalCharacterV2[]>([]);
  const [personalLibraryReady, setPersonalLibraryReady] = useState(false);
  const characters = useMemo(() => {
    const merged = new Map(personalCharacters.map((record) => [record.characterId, record.character]));
    for (const character of roomCharacters) merged.set(character.id, character);
    return [...merged.values()];
  }, [personalCharacters, roomCharacters]);
  const ownRoomCharacter = roomCharacters.find((character) => character.ownerPeerId === localOwnerId);
  const own = ownRoomCharacter
    ?? personalCharacters.find((record) => record.character.ownerPeerId === localOwnerId)?.character;
  const [draft, setDraft] = useState<Coc7Character>(() => own ?? createCharacter(
    effectiveLocalOwnerId,
    displayName,
  ));
  const [draftContextScope, setDraftContextScope] = useState(draftStorageScope);
  const [privateNotes, setPrivateNotes] = useState("");
  const [cleanSnapshot, setCleanSnapshot] = useState<string | undefined>(() => characterDraftSnapshot(draft, ""));
  const [pendingRoomSnapshot, setPendingRoomSnapshot] = useState<string>();
  const [error, setError] = useState<string>();
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiDraftNotice, setAiDraftNotice] = useState<string>();
  const [rulesConfirmed, setRulesConfirmed] = useState(false);
  const [savingTarget, setSavingTarget] = useState<"personal" | "room">();
  const [roomEditBaseUpdatedAt, setRoomEditBaseUpdatedAt] = useState<string | null | "unknown">(
    ownRoomCharacter?.updatedAt ?? null,
  );
  const [recoverableDraft, setRecoverableDraft] = useState<RecoverableCharacterDraftV1 | undefined>(() => (
    readRecoverableCharacterDraft(draftStorageScope)
  ));
  const browserImportRef = useRef<HTMLInputElement>(null);
  const autoSelectedForRoomRef = useRef<string>();
  const draftStorageKeyRef = useRef(draftStorageKey);
  const saveInFlightRef = useRef(false);
  const liveDraftRef = useRef(draft);
  const livePrivateNotesRef = useRef(privateNotes);
  liveDraftRef.current = draft;
  livePrivateNotesRef.current = privateNotes;
  const dirty = cleanSnapshot === undefined || cleanSnapshot !== characterDraftSnapshot(draft, privateNotes);
  const dirtyRef = useRef(dirty);
  const draftNameRef = useRef(draft.name);
  const selectedPersonalRecord = personalCharacters.find((record) => record.characterId === draft.id);
  const selectedRoomCharacter = roomCharacters.find((character) => character.id === draft.id);
  const isLocallyOwnedDraft = !currentRoom
    || draft.ownerPeerId === effectiveLocalOwnerId
    || draft.ownerPeerId === localOwnerId
    || Boolean(selectedPersonalRecord);
  const roomSnapshot = selectedRoomCharacter ? roomCharacterSnapshot(selectedRoomCharacter) : undefined;
  const roomNeedsSync = Boolean(
    currentRoom
      && roomCharacterSnapshot(draft) !== (pendingRoomSnapshot ?? roomSnapshot),
  );
  const roomVersionConflict = Boolean(
    currentRoom
      && roomEditBaseUpdatedAt !== null
      && (
        roomEditBaseUpdatedAt === "unknown"
        || !selectedRoomCharacter
        || selectedRoomCharacter.updatedAt !== roomEditBaseUpdatedAt
      ),
  );
  const personalNeedsSave = isLocallyOwnedDraft && (
    !selectedPersonalRecord
      || characterDraftSnapshot(selectedPersonalRecord.character, selectedPersonalRecord.privateNotes)
        !== characterDraftSnapshot(draft, privateNotes)
  );
  const identityReady = draft.name.trim().length > 0
    && draft.name.trim() !== "新调查员"
    && draft.playerName.trim().length > 0
    && draft.occupation.trim().length > 0;
  const attributesReady = Object.values(draft.characteristics).every((value) => value > 0);
  const skillsReady = draft.skills.some((skill) => (
    skill.name.trim().length > 0
    && skill.name.trim() !== "新技能"
    && skill.value > 0
  ));
  const characterReady = identityReady && attributesReady && skillsReady;
  const needsRulesConfirmation = Boolean(currentRoom && !selectedRoomCharacter && characterReady && !rulesConfirmed);
  const backgroundStarted = Object.values(draft.background).some((value) => value.trim().length > 0);
  const hasActiveStatus = Object.values(draft.status).some(Boolean);
  const awaitingPersonalLibrary = Boolean(
    currentRoom
      && !selectedRoomCharacter
      && !selectedPersonalRecord
      && !personalLibraryReady
      && !dirty,
  );
  const nextCharacterStep: { href?: string; label: string; detail: string } = awaitingPersonalLibrary
    ? {
        label: "正在查找你保存过的调查员",
        detail: "如果这台电脑已有角色，会先选中最近使用的一位；不会自动发进房间。",
      }
    : selectedRoomCharacter
    ? roomNeedsSync
      ? { href: "#character-save-actions", label: "保存这次角色修改", detail: "同步成功后就回到现场，不必再从菜单绕一圈。" }
      : dirty
        ? { href: "#character-save-actions", label: "保存只留在本机的修改", detail: "房间角色卡没有变化；先保存私人笔记或本机资料，再回到现场。" }
        : { href: "#character-save-actions", label: "调查员已经在现场", detail: "这张卡已经可以用于行动与检定；现在可以直接回到跑团现场。" }
    : !identityReady
      ? { href: "#character-identity", label: "先写姓名与职业", detail: "让大家知道你将扮演谁。" }
    : !attributesReady
      ? { href: "#character-attributes", label: "检查九项属性", detail: "按本团采用的车卡方式填写数值。" }
      : !skillsReady
        ? { href: "#character-skills", label: "添加常用技能", detail: "至少添加一项你最常使用的技能。" }
        : needsRulesConfirmation
          ? selectedPersonalRecord
            ? { href: "#character-save-actions", label: `确认是否带入“${draft.name}”`, detail: "已选中这台电脑最近使用的调查员。和 KP 核对本团的车卡方式后即可加入现场。" }
            : { href: "#character-save-actions", label: "和 KP 确认这张卡", detail: "确认属性生成与技能点分配符合本团采用的规则。" }
        : {
            href: "#character-save-actions",
            label: currentRoom ? "可以带入房间" : "基本资料可以保存",
            detail: currentRoom ? "背景、装备和笔记都可以之后边玩边补。" : "这表示主要字段已填写，不代表完成了本团的点数规则校验。",
          };
  const canContinueToLiveRoom = Boolean(currentRoom && selectedRoomCharacter && !roomNeedsSync && !dirty);
  const roomPaused = Boolean(
    currentRoom && sessionV1 && !isRoomHostAvailable(currentRoom, participants, paths[currentRoom.hostPeerId]),
  );
  const hasEditPermission = !currentRoom || isLocallyOwnedDraft || Boolean(session && !roomPaused && session.isHost);
  const canEdit = hasEditPermission && !recoverableDraft && savingTarget === undefined;

  const refreshPersonalLibrary = async () => {
    const repository = await getRepository();
    const records = await repository.listPersonalCharactersV2();
    setPersonalCharacters(records);
    setPersonalLibraryReady(true);
    return records;
  };

  useEffect(() => {
    void refreshPersonalLibrary().catch((cause) => {
      setPersonalLibraryReady(true);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, []);

  useEffect(() => {
    if (!personalLibraryReady || !currentRoom || autoSelectedForRoomRef.current === currentRoom.id) return;
    autoSelectedForRoomRef.current = currentRoom.id;
    if (session?.isHost || selectedRoomCharacter || selectedPersonalRecord || dirty) return;
    const recent = personalCharacters[0];
    if (!recent) return;
    setDraft(recent.character);
    setPrivateNotes(recent.privateNotes);
    setCleanSnapshot(characterDraftSnapshot(recent.character, recent.privateNotes));
    setPendingRoomSnapshot(undefined);
    setRoomEditBaseUpdatedAt(roomCharacters.find((character) => character.id === recent.characterId)?.updatedAt ?? null);
    setRulesConfirmed(false);
    setError(undefined);
  }, [currentRoom, dirty, personalCharacters, personalLibraryReady, roomCharacters, selectedPersonalRecord, selectedRoomCharacter, session?.isHost]);

  useEffect(() => {
    draftStorageKeyRef.current = draftStorageKey;
    setRecoverableDraft(readRecoverableCharacterDraft(draftStorageScope));
  }, [draftStorageKey, draftStorageScope]);

  useEffect(() => {
    if (
      !dirty
      || !hasEditPermission
      || recoverableDraft
      || savingTarget
      || draftContextScope !== draftStorageScope
    ) return;
    writeRecoverableCharacterDraft(
      draftStorageScope,
      draft,
      privateNotes,
      roomEditBaseUpdatedAt,
    );
  }, [dirty, draft, draftContextScope, draftStorageScope, hasEditPermission, privateNotes, recoverableDraft, roomEditBaseUpdatedAt, savingTarget]);

  useEffect(() => {
    dirtyRef.current = dirty;
    draftNameRef.current = draft.name;
  }, [dirty, draft.name]);

  useEffect(() => {
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (previous.activeView === "characters" && state.activeView !== "characters" && saveInFlightRef.current) {
        useAppStore.getState().setActiveView("characters");
        return;
      }
      if (
        previous.activeView === "characters"
        && state.activeView !== "characters"
        && dirtyRef.current
        && !window.confirm(`“${draftNameRef.current}”还有未保存的修改。确定离开并放弃这些修改吗？`)
      ) {
        useAppStore.getState().setActiveView("characters");
      } else if (previous.activeView === "characters" && state.activeView !== "characters" && dirtyRef.current) {
        clearRecoverableCharacterDraftByKey(draftStorageKeyRef.current);
      }
    });
    const preventAccidentalClose = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventAccidentalClose);
    return () => {
      unsubscribe();
      window.removeEventListener("beforeunload", preventAccidentalClose);
    };
  }, []);

  useEffect(() => {
    if (draftContextScope === draftStorageScope) return;
    const preservedPreviousDraft = dirty;
    const next = own ?? createCharacter(effectiveLocalOwnerId, displayName);
    const nextPrivateNotes = personalCharacters.find((record) => record.characterId === next.id)?.privateNotes ?? "";
    setDraft(next);
    setDraftContextScope(draftStorageScope);
    setPrivateNotes(nextPrivateNotes);
    setCleanSnapshot(characterDraftSnapshot(next, nextPrivateNotes));
    setPendingRoomSnapshot(undefined);
    setRoomEditBaseUpdatedAt(roomCharacters.some((character) => character.id === next.id) ? next.updatedAt : null);
    setRulesConfirmed(false);
    setError(preservedPreviousDraft
      ? "调查环境或席位已经切换；上一处的未保存草稿仍留在它自己的恢复点，不会带入这里。"
      : undefined);
  }, [currentRoom, dirty, displayName, draftContextScope, draftStorageScope, effectiveLocalOwnerId, own, personalCharacters, roomCharacters]);

  useEffect(() => {
    if (dirty) return;
    if (pendingRoomSnapshot && pendingRoomSnapshot === roomSnapshot) {
      setPendingRoomSnapshot(undefined);
    }
    const personalRecordMatchesDraft = selectedPersonalRecord
      && characterDraftSnapshot(selectedPersonalRecord.character, selectedPersonalRecord.privateNotes)
        === characterDraftSnapshot(draft, privateNotes);
    // A deliberately saved personal copy may be ahead of the room copy. Keep it
    // selected so the user can decide whether to publish it instead of silently
    // replacing it with an older authoritative room event.
    if (personalRecordMatchesDraft) return;
    const synchronized = characters.find((character) => character.id === draft.id);
    if (synchronized && synchronized.updatedAt !== draft.updatedAt) {
      const nextPrivateNotes = personalCharacters.find((record) => record.characterId === synchronized.id)?.privateNotes ?? "";
      setDraft(synchronized);
      setPrivateNotes(nextPrivateNotes);
      setCleanSnapshot(characterDraftSnapshot(synchronized, nextPrivateNotes));
      setRoomEditBaseUpdatedAt(roomCharacters.some((roomCharacter) => roomCharacter.id === synchronized.id) ? synchronized.updatedAt : null);
      return;
    }
    if (!synchronized && own && draft.ownerPeerId === localOwnerId && draft.id !== own.id) {
      const nextPrivateNotes = personalCharacters.find((record) => record.characterId === own.id)?.privateNotes ?? "";
      setDraft(own);
      setPrivateNotes(nextPrivateNotes);
      setCleanSnapshot(characterDraftSnapshot(own, nextPrivateNotes));
      setPendingRoomSnapshot(undefined);
      setRoomEditBaseUpdatedAt(roomCharacters.some((roomCharacter) => roomCharacter.id === own.id) ? own.updatedAt : null);
    }
  }, [characters, dirty, draft, localOwnerId, own, pendingRoomSnapshot, personalCharacters, privateNotes, roomCharacters, roomSnapshot, selectedPersonalRecord]);

  const confirmDiscardChanges = (action: string) => (
    !saveInFlightRef.current
      && (!dirty || window.confirm(`“${draft.name}”还有未保存的修改。确定放弃这些修改并${action}吗？`))
  );

  const clearCurrentRecovery = () => {
    clearRecoverableCharacterDraftByKey(draftStorageKey);
    setRecoverableDraft(undefined);
  };

  const checkpointCurrentDraft = () => {
    writeRecoverableCharacterDraft(
      draftStorageScope,
      draft,
      privateNotes,
      roomEditBaseUpdatedAt,
    );
  };

  const restoreRecoveredDraft = () => {
    if (!recoverableDraft) return;
    autoSelectedForRoomRef.current = currentRoom?.id;
    setDraft(recoverableDraft.character);
    setPrivateNotes(recoverableDraft.privateNotes);
    setCleanSnapshot(undefined);
    setPendingRoomSnapshot(undefined);
    setRoomEditBaseUpdatedAt(
      recoverableDraft.version === 2
        ? recoverableDraft.baseRoomUpdatedAt ?? null
        : currentRoom ? "unknown" : null,
    );
    setRulesConfirmed(false);
    setRecoverableDraft(undefined);
    setError(undefined);
  };

  const loadCleanDraft = (character: Coc7Character) => {
    const notes = personalCharacters.find((record) => record.characterId === character.id)?.privateNotes ?? "";
    setDraft(character);
    setPrivateNotes(notes);
    setCleanSnapshot(characterDraftSnapshot(character, notes));
    setPendingRoomSnapshot(undefined);
    setRoomEditBaseUpdatedAt(roomCharacters.some((roomCharacter) => roomCharacter.id === character.id) ? character.updatedAt : null);
    setRulesConfirmed(false);
    setError(undefined);
  };

  const editDraft = (
    updater: (current: Coc7Character) => Coc7Character,
    recalculateDerived = false,
  ) => {
    setRulesConfirmed(false);
    setDraft((current) => {
      const next = updater(current);
      if (!recalculateDerived) return next;
      return {
        ...next,
        derived: deriveCoc7Stats({
          characteristics: next.characteristics,
          age: next.age,
          skills: next.skills,
          current: next.derived,
        }),
      };
    });
    setError(undefined);
  };

  const selectCharacter = (character: Coc7Character) => {
    if (character.id === draft.id || !confirmDiscardChanges(`打开“${character.name}”`)) return;
    clearCurrentRecovery();
    loadCleanDraft(character);
  };

  const updateCharacteristic = (key: CharacteristicKey, value: number) => {
    editDraft((current) => ({
      ...current,
      characteristics: { ...current.characteristics, [key]: value },
    }), true);
  };

  const updateCurrentResource = (key: CurrentResourceKey, value: number) => {
    editDraft((current) => {
      const maximum = Number(current.derived[currentResourceMaximum[key]]);
      return {
        ...current,
        derived: {
          ...current.derived,
          [key]: clampInteger(value, 0, maximum),
        },
      };
    });
  };

  const addSkill = () => {
    editDraft((current) => ({
      ...current,
      skills: [...current.skills, createSkill()],
    }), true);
  };

  const addCommonInvestigationSkills = () => {
    editDraft((current) => {
      const existing = new Set(current.skills.map((skill) => skill.name.trim()));
      const additions = commonInvestigationSkills(current.characteristics.dex)
        .filter((skill) => !existing.has(skill.name));
      return additions.length === 0
        ? current
        : { ...current, skills: [...current.skills, ...additions].slice(0, 200) };
    }, true);
  };

  const updateSkill = (id: string, update: (skill: Skill) => Skill) => {
    editDraft((current) => ({
      ...current,
      skills: current.skills.map((skill) => skill.id === id ? update(skill) : skill),
    }), true);
  };

  const removeSkill = (id: string) => {
    editDraft((current) => ({
      ...current,
      skills: current.skills.filter((skill) => skill.id !== id),
    }), true);
  };

  const addInventoryItem = () => {
    editDraft((current) => ({
      ...current,
      inventory: [...current.inventory, createInventoryItem()],
    }));
  };

  const updateInventoryItem = (id: string, update: (item: InventoryItem) => InventoryItem) => {
    editDraft((current) => ({
      ...current,
      inventory: current.inventory.map((item) => item.id === id ? update(item) : item),
    }));
  };

  const removeInventoryItem = (id: string) => {
    editDraft((current) => ({
      ...current,
      inventory: current.inventory.filter((item) => item.id !== id),
    }));
  };

  const prepareCharacterForSave = (bindToCurrentSeat = false) => coc7CharacterSchema.parse({
    ...draft,
    ...(bindToCurrentSeat && selectedPersonalRecord && localOwnerId ? { ownerPeerId: localOwnerId } : {}),
    derived: deriveCoc7Stats({
      characteristics: draft.characteristics,
      age: draft.age,
      skills: draft.skills,
      current: draft.derived,
    }),
    updatedAt: new Date().toISOString(),
  });

  const persistPersonalCharacter = async (character: Coc7Character, notes: string) => {
    const repository = await getRepository();
    const existing = personalCharacters.find((record) => record.characterId === character.id);
    const now = new Date().toISOString();
    await repository.savePersonalCharacterV2({
      characterId: character.id,
      revision: (existing?.revision ?? 0) + 1,
      character,
      privateNotes: notes,
      ...(existing?.avatarAssetId ? { avatarAssetId: existing.avatarAssetId } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await refreshPersonalLibrary();
  };

  const saveToPersonalLibrary = async () => {
    if (saveInFlightRef.current) return;
    const submittedSnapshot = characterDraftSnapshot(draft, privateNotes);
    checkpointCurrentDraft();
    saveInFlightRef.current = true;
    setSavingTarget("personal");
    try {
      if (!isLocallyOwnedDraft) throw new Error("只能把自己的角色保存到个人角色库");
      const character = prepareCharacterForSave();
      await persistPersonalCharacter(character, privateNotes);
      if (characterDraftSnapshot(liveDraftRef.current, livePrivateNotesRef.current) !== submittedSnapshot) {
        setError("较早的版本已保存，但保存期间出现了新修改；新修改仍保留在表单和恢复草稿中，请再次保存。");
        return;
      }
      clearCurrentRecovery();
      setDraft(character);
      setCleanSnapshot(characterDraftSnapshot(character, privateNotes));
      dirtyRef.current = false;
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      saveInFlightRef.current = false;
      setSavingTarget(undefined);
    }
  };

  const saveToCurrentRoom = async () => {
    if (saveInFlightRef.current) return;
    const submittedSnapshot = characterDraftSnapshot(draft, privateNotes);
    checkpointCurrentDraft();
    saveInFlightRef.current = true;
    setSavingTarget("room");
    try {
      if (!currentRoom || !session) throw new Error("当前没有可加入的房间");
      if (roomPaused) throw new Error("房主当前离线，房间已暂停");
      if (!session.isHost && !isLocallyOwnedDraft) throw new Error("玩家只能把自己的角色带入房间");
      if (roomVersionConflict) throw new Error("房间里的角色卡已经更新，不能用旧编辑稿直接覆盖。请先备份草稿，再改用房间最新版。");
      if (!selectedRoomCharacter && !characterReady) throw new Error("请先填写姓名、职业、属性和至少一项常用技能");
      if (!selectedRoomCharacter && !rulesConfirmed) throw new Error("带入房间前，请先确认这张卡符合本团采用的车卡规则");
      const character = prepareCharacterForSave(true);
      if (sessionV2) {
        await sessionV2.submitConfirmed({
          type: "character.updated",
          audience: { kind: "room" },
          payload: { character },
        });
      } else if (sessionV1) {
        await sessionV1.submitConfirmed("character.update", { character });
      }
      if (isLocallyOwnedDraft) await persistPersonalCharacter(character, privateNotes);
      if (characterDraftSnapshot(liveDraftRef.current, livePrivateNotesRef.current) !== submittedSnapshot) {
        setPendingRoomSnapshot(roomCharacterSnapshot(character));
        setError("房间已经接受较早的版本，但保存期间出现了新修改；新修改仍保留在表单和恢复草稿中，请再次保存。");
        return;
      }
      clearCurrentRecovery();
      setDraft(character);
      setCleanSnapshot(characterDraftSnapshot(character, privateNotes));
      setPendingRoomSnapshot(roomCharacterSnapshot(character));
      setRoomEditBaseUpdatedAt(character.updatedAt);
      dirtyRef.current = false;
      setError(undefined);
      if (!session.isHost) {
        saveInFlightRef.current = false;
        setSavingTarget(undefined);
        useAppStore.getState().setActiveView("room");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      saveInFlightRef.current = false;
      setSavingTarget(undefined);
    }
  };

  const createPersonalCharacter = () => {
    if (!confirmDiscardChanges("新建角色")) return;
    clearCurrentRecovery();
    autoSelectedForRoomRef.current = currentRoom?.id;
    const character = createCharacter(effectiveLocalOwnerId, displayName);
    setDraft(character);
    setPrivateNotes("");
    setCleanSnapshot(undefined);
    setPendingRoomSnapshot(undefined);
    setRoomEditBaseUpdatedAt(null);
    setRulesConfirmed(false);
    setError(undefined);
  };

  const generateCharacterDraft = async () => {
    if (!requestCharacterDraft) return;
    if (!confirmDiscardChanges("用 AI 草稿替换当前角色")) return;
    try {
      clearCurrentRecovery();
      setAiBusy(true);
      setError(undefined);
      setAiDraftNotice(undefined);
      const generated = coc7CharacterSchema.parse(await requestCharacterDraft(aiPrompt, displayName));
      setDraft(generated);
      setPrivateNotes("");
      setCleanSnapshot(undefined);
      setPendingRoomSnapshot(undefined);
      setRoomEditBaseUpdatedAt(null);
      setRulesConfirmed(false);
      setAiDraftNotice("这仍是未保存草稿。你可以只存进个人角色库；确认无误后，再选择是否带入当前房间。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAiBusy(false);
    }
  };

  const importCoccharBytes = async (bytes: Uint8Array) => {
    const imported = await parseCoccharPackage(bytes);
    const character = coc7CharacterSchema.parse({
      ...imported.character,
      ownerPeerId: localOwnerId ?? imported.character.ownerPeerId,
      updatedAt: new Date().toISOString(),
    });
    const repository = await getRepository();
    const existing = personalCharacters.find((record) => record.characterId === character.id);
    let avatarAssetId = existing?.avatarAssetId;
    if (imported.avatar && hasManagedAssetStore()) {
      const managed = await importManagedAssetBytes("image", imported.avatar.bytes, imported.avatar.descriptor.mediaType);
      avatarAssetId = managed.asset.assetId;
      await addManagedAssetReference({
        assetId: managed.asset.assetId,
        ownerType: "character",
        ownerId: character.id,
        ownerRevision: (existing?.revision ?? 0) + 1,
        slot: "avatar",
      });
    }
    const now = new Date().toISOString();
    await repository.savePersonalCharacterV2({
      characterId: character.id,
      revision: (existing?.revision ?? 0) + 1,
      character,
      privateNotes: imported.privateNotes,
      ...(avatarAssetId ? { avatarAssetId } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await refreshPersonalLibrary();
    clearCurrentRecovery();
    setDraft(character);
    setPrivateNotes(imported.privateNotes);
    setCleanSnapshot(characterDraftSnapshot(character, imported.privateNotes));
    setPendingRoomSnapshot(undefined);
    setRoomEditBaseUpdatedAt(null);
    setRulesConfirmed(false);
    setError(undefined);
  };

  const importCocchar = async () => {
    try {
      if (!window.__TAURI_INTERNALS__) return browserImportRef.current?.click();
      const path = await open({ multiple: false, filters: [{ name: "CoC character", extensions: ["cocchar"] }] });
      if (typeof path === "string" && confirmDiscardChanges("导入另一张角色卡")) {
        await importCoccharBytes(await readFile(path));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const importBrowserCocchar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (!confirmDiscardChanges("导入另一张角色卡")) return;
      if (file.size > 32 * 1024 * 1024) throw new Error(".cocchar 超过 32 MiB，已拒绝导入");
      await importCoccharBytes(new Uint8Array(await file.arrayBuffer()));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const exportCocchar = async () => {
    try {
      const avatarAssetId = personalCharacters.find((record) => record.characterId === draft.id)?.avatarAssetId;
      const avatar = avatarAssetId && hasManagedAssetStore()
        ? await readCoccharAvatar(avatarAssetId)
        : undefined;
      const bytes = await createCoccharPackage({ character: draft, privateNotes, ...(avatar ? { avatar } : {}) });
      const fileName = `${safeCharacterFileName(draft.name)}.cocchar`;
      if (window.__TAURI_INTERNALS__) {
        const path = await save({ defaultPath: fileName, filters: [{ name: "CoC character", extensions: ["cocchar"] }] });
        if (path) await writeFile(path, bytes);
      } else {
        downloadBytesInBrowser(fileName, bytes, "application/vnd.coc-room.character+zip");
      }
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const personalCharacterChoices = personalCharacters.map(({ character }) => character);
  const personalCharacterIds = new Set(personalCharacters.map(({ characterId }) => characterId));
  const roomOnlyCharacterChoices = roomCharacters.filter(({ id }) => !personalCharacterIds.has(id));
  const renderCharacterChoice = (character: Coc7Character) => {
    const inPersonalLibrary = personalCharacterIds.has(character.id);
    const inCurrentRoom = roomCharacters.some((roomCharacter) => roomCharacter.id === character.id);
    return <button
      key={character.id}
      type="button"
      disabled={Boolean(recoverableDraft) || Boolean(savingTarget)}
      onClick={() => selectCharacter(character)}
      className={`rounded-md border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-45 ${draft.id === character.id ? "border-brass/60 bg-amber-950/20" : "border-transparent bg-zinc-900 hover:bg-zinc-800"}`}
    >
      <div className="font-medium">{character.name}</div>
      <div className="mt-1 text-xs text-zinc-500">{character.occupation || "无职业"} · 玩家 {character.playerName}</div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
        {inPersonalLibrary && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">我的本机角色</span>}
        {inCurrentRoom && <span className="rounded bg-amber-950/40 px-1.5 py-0.5 text-amber-300">本房间</span>}
      </div>
    </button>;
  };

  return (
    <div className="h-full overflow-y-auto p-4 md:p-7">
      <div className="mx-auto grid max-w-7xl gap-6">
        <header>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[.3em] text-brass">调查员档案</p>
              <h1 className="mt-2 font-serif text-3xl">我的调查员</h1>
              <p className="mt-1 text-sm text-zinc-400">
                先填姓名、属性和常用技能，再按本团规则与 KP 核对；背景与装备可以边玩边补。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {currentRoom && <Button disabled={Boolean(savingTarget)} variant="ghost" onClick={() => useAppStore.getState().setActiveView("room")}><ArrowLeft className="mr-2 h-4 w-4" />回到现场</Button>}
              <input ref={browserImportRef} type="file" accept=".cocchar,application/zip" className="hidden" onChange={(event) => void importBrowserCocchar(event)} />
              <Button disabled={Boolean(recoverableDraft) || Boolean(savingTarget)} variant="secondary" onClick={() => void importCocchar()}><Upload className="mr-2 h-4 w-4" />从文件导入</Button>
              <Button disabled={Boolean(recoverableDraft) || Boolean(savingTarget)} variant="secondary" onClick={() => void exportCocchar()}><Download className="mr-2 h-4 w-4" />备份到文件</Button>
            </div>
          </div>
        </header>

        {recoverableDraft && <section aria-label="发现未保存的角色草稿" className="rounded-xl border border-amber-700/60 bg-amber-950/25 p-4">
          <p className="text-xs font-semibold uppercase tracking-[.18em] text-amber-300">发现这次编辑留下的草稿</p>
          <h2 className="mt-2 font-semibold text-zinc-100">要继续编辑“{recoverableDraft.character.name}”吗？</h2>
          <p className="mt-1 text-sm leading-6 text-zinc-400">草稿只保存在这台电脑的当前浏览器标签页中，尚未进入个人角色库，也没有发布给房间。恢复后仍需由你明确保存或带入。</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={restoreRecoveredDraft}>恢复草稿</Button>
            <Button variant="ghost" className="text-red-300" onClick={clearCurrentRecovery}>放弃草稿</Button>
          </div>
        </section>}

        <div className="grid gap-5 lg:grid-cols-[250px_minmax(0,1fr)]">
          <Panel className="content-start lg:sticky lg:top-0">
            <h2 className="mb-1 font-semibold">角色</h2>
            <p className="mb-3 text-xs leading-5 text-zinc-500">个人库只属于这台电脑；本房间调查员是团友正在使用的角色。</p>
            <div className="grid gap-2">
              <section aria-label="我的角色库" className="grid gap-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-[.16em] text-zinc-500">我的角色库 · {personalCharacterChoices.length}</h3>
                {personalCharacterChoices.length > 0 ? personalCharacterChoices.map(renderCharacterChoice) : <p className="rounded border border-dashed border-zinc-800 p-3 text-xs leading-5 text-zinc-600">还没有保存到这台电脑的角色。</p>}
              </section>
              {currentRoom && <section aria-label="本房间调查员" className="mt-2 grid gap-2 border-t border-zinc-800 pt-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-[.16em] text-zinc-500">本房间调查员 · {roomCharacters.length}</h3>
                {roomOnlyCharacterChoices.length > 0 ? roomOnlyCharacterChoices.map(renderCharacterChoice) : <p className="rounded border border-dashed border-zinc-800 p-3 text-xs leading-5 text-zinc-600">其他调查员还没有带入角色。</p>}
              </section>}
              <Button disabled={Boolean(recoverableDraft) || Boolean(savingTarget)} aria-label="新建我的角色" variant="secondary" onClick={createPersonalCharacter}>
                <UserRound className="mr-2 h-4 w-4" />新建个人角色
              </Button>
            </div>
          </Panel>

          <Panel className="grid gap-8">
            {!recoverableDraft && <section aria-label="角色创建进度" className="rounded-xl border border-amber-900/50 bg-amber-950/15 p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[.2em] text-brass">现在该做什么</p>
                  <h2 className="mt-2 text-lg font-semibold text-ink">{nextCharacterStep.label}</h2>
                  <p className="mt-1 text-sm text-zinc-400">{nextCharacterStep.detail}</p>
                </div>
                {canContinueToLiveRoom
                  ? <Button onClick={() => useAppStore.getState().setActiveView("room")}>继续跑团</Button>
                  : nextCharacterStep.href ? <a
                      href={nextCharacterStep.href}
                      className="inline-flex h-10 items-center justify-center rounded-md bg-amber-600 px-4 text-sm font-semibold text-zinc-950 transition hover:bg-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-300"
                    >
                      {selectedRoomCharacter
                        ? roomNeedsSync ? "去保存修改" : "去保存本机修改"
                        : !characterReady ? "继续填写" : needsRulesConfirmation ? "去确认" : currentRoom ? "去带入房间" : "去保存"}
                    </a>
                  : <span role="status" className="inline-flex h-10 items-center text-sm text-zinc-400"><Loader2 className="mr-2 h-4 w-4 animate-spin" />读取角色库</span>}
              </div>
              <ol className={`mt-4 grid gap-2 text-sm ${currentRoom && !selectedRoomCharacter ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}>
                <ReadinessStep ready={identityReady} label="1. 身份" pending="填写姓名与职业" />
                <ReadinessStep ready={attributesReady} label="2. 属性已填" pending="填写属性数值" />
                <ReadinessStep ready={skillsReady} label="3. 技能已填" pending="至少添加一项" />
                {currentRoom && !selectedRoomCharacter && <ReadinessStep ready={rulesConfirmed} label="4. 团规确认" pending="与 KP 核对" />}
              </ol>
              <p className="mt-3 text-xs leading-5 text-zinc-500">这里检查的是跑团所需的基本字段，不会假定所有团都采用同一种属性生成或技能点规则。</p>
            </section>}

            {!canEdit && !recoverableDraft && (
              <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-400">
                <LockKeyhole className="h-4 w-4 shrink-0" />
                {roomPaused
                  ? "房主已离线，房间暂停；房主回来后才能新建、修改或同步角色卡。"
                  : savingTarget
                    ? savingTarget === "room" ? "正在等待房间确认角色卡；完成前暂时锁定编辑，避免吞掉新的修改。" : "正在保存到个人角色库；完成前暂时锁定编辑，避免吞掉新的修改。"
                  : session
                  ? "只有角色所有者与主持人可以修改这张角色卡。"
                  : currentRoom
                    ? "本地记录为只读；重新连接房间后才能新建或修改角色卡。"
                    : "请选择自己的个人角色进行编辑。"}
              </div>
            )}
            {canEdit && currentRoom && (!session || roomPaused) && (
              <div className="flex items-center gap-2 rounded-lg border border-amber-900/60 bg-amber-950/15 px-4 py-3 text-sm text-amber-100">
                <LockKeyhole className="h-4 w-4 shrink-0" />
                现在仍可编辑并保存到个人角色库；重新连接房间后，才能把角色卡带入或更新到当前房间。
              </div>
            )}

            {roomVersionConflict && (
              <div aria-label="角色草稿版本冲突" className="rounded-lg border border-amber-700/60 bg-amber-950/20 p-4 text-sm text-amber-100">
                <p className="font-medium">房间里的这张角色卡已经在草稿保存后更新。</p>
                <p className="mt-1 leading-6 text-amber-100/75">为避免回滚 KP 或另一端的新修改，恢复草稿不能直接发回房间。你可以先保存到个人角色库留作备份，再改用房间最新版继续编辑。</p>
                {selectedRoomCharacter && <Button className="mt-3" variant="secondary" onClick={() => {
                  clearCurrentRecovery();
                  loadCleanDraft(selectedRoomCharacter);
                }}>改用房间最新版</Button>}
              </div>
            )}

            {isV2 && currentRoom && sessionV2 && requestCharacterDraft && draft.ownerPeerId === localOwnerId && (
              <details className="rounded-xl border border-zinc-800 bg-zinc-950/35 px-4 py-3">
                <summary className="cursor-pointer font-medium text-zinc-200">想快速起步？用一句话生成草稿（可选）</summary>
                <p className="mt-2 text-sm leading-6 text-zinc-400">描述年代、职业、性格和擅长的事。生成结果只会填入当前表单，确认前不会进入房间。</p>
                <div className="grid gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
                  <Textarea disabled={aiBusy || roomPaused} maxLength={8_000} className="min-h-28" value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} placeholder="例如：1920 年代东京的谨慎女记者，擅长图书馆使用、心理学与摄影，害怕深海。" />
                  <Button className="justify-self-start" disabled={aiBusy || roomPaused || !aiPrompt.trim()} onClick={() => void generateCharacterDraft()}>
                    {aiBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}生成待审核草稿
                  </Button>
                  {aiDraftNotice && <p className="text-xs leading-5 text-amber-200">{aiDraftNotice}</p>}
                  <details className="text-xs text-zinc-500">
                    <summary className="cursor-pointer">这段描述会发到哪里？</summary>
                    <p className="mt-2 leading-5">请求由房主本机的受限 AI 通道处理，只能生成角色草稿，不能读取房间记录、模组或本机文件。房主决定使用哪项服务。</p>
                  </details>
                </div>
              </details>
            )}

            {isV2 && sessionV2?.isHost && hostCharacterDrafts.length > 0 && (
              <Section title="等待你确认的玩家角色" description="玩家用一句话生成了以下草稿。先打开检查，确认后再带入房间。">
                <div className="grid gap-2">{hostCharacterDrafts.map((review) => <div key={review.jobId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-900/60 bg-amber-950/10 p-3 text-sm">
                  <div><b>{review.character.name}</b><p className="mt-1 text-xs text-zinc-500">申请玩家：{review.requesterName} · {review.character.occupation || "未指定职业"}</p></div>
                  <div className="flex gap-2"><Button variant="secondary" onClick={() => {
                    if (!confirmDiscardChanges(`打开“${review.character.name}”的审核草稿`)) return;
                    setDraft(review.character);
                    setPrivateNotes("");
                    setCleanSnapshot(undefined);
                    setPendingRoomSnapshot(undefined);
                    setRoomEditBaseUpdatedAt(null);
                    setRulesConfirmed(false);
                    setAiDraftNotice("KP 正在审核玩家草稿；只有点击“带入当前房间”后，完整角色卡才会向房间发布。");
                  }}>打开审核</Button><Button variant="ghost" onClick={() => onDismissHostCharacterDraft?.(review.jobId)}>丢弃</Button></div>
                </div>)}</div>
              </Section>
            )}

            <Section id="character-identity" title="1. 我是谁">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Field label="姓名">
                  <Input disabled={!canEdit} maxLength={160} value={draft.name} onChange={(event) => editDraft((current) => ({ ...current, name: event.target.value }))} />
                </Field>
                <Field label="玩家">
                  <Input disabled={!canEdit} maxLength={160} value={draft.playerName} onChange={(event) => editDraft((current) => ({ ...current, playerName: event.target.value }))} />
                </Field>
                <Field label="职业">
                  <Input disabled={!canEdit} maxLength={160} value={draft.occupation} onChange={(event) => editDraft((current) => ({ ...current, occupation: event.target.value }))} />
                </Field>
                <Field label="年龄" hint="40 岁起会降低移动力">
                  <Input
                    disabled={!canEdit}
                    type="number"
                    min={15}
                    max={120}
                    value={draft.age}
                    onChange={(event) => editDraft((current) => ({ ...current, age: Number(event.target.value) }), true)}
                  />
                </Field>
                <Field label="居住地">
                  <Input disabled={!canEdit} maxLength={240} value={draft.residence} onChange={(event) => editDraft((current) => ({ ...current, residence: event.target.value }))} />
                </Field>
                <Field label="出生地">
                  <Input disabled={!canEdit} maxLength={240} value={draft.birthplace} onChange={(event) => editDraft((current) => ({ ...current, birthplace: event.target.value }))} />
                </Field>
              </div>
            </Section>

            <Section id="character-attributes" title="2. 九项属性" description="初始值暂填为 50，请按本团采用的车卡方式调整；生命、魔法、移动力等会自动计算。">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                {(Object.entries(characteristicLabels) as Array<[CharacteristicKey, string]>).map(([key, label]) => (
                  <Field key={key} label={label}>
                    <Input
                      disabled={!canEdit}
                      type="number"
                      min={0}
                      max={100}
                      value={draft.characteristics[key]}
                      onChange={(event) => updateCharacteristic(key, clampInteger(Number(event.target.value), 0, 100))}
                    />
                  </Field>
                ))}
              </div>
            </Section>

            <Section title="游戏中的数值" description="游戏中通常只需修改当前生命、魔法与理智；其他数值由属性自动计算。">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="当前生命 HP" hint={`上限 ${draft.derived.maxHitPoints}`}>
                  <Input disabled={!canEdit} type="number" min={0} max={draft.derived.maxHitPoints} value={draft.derived.hitPoints} onChange={(event) => updateCurrentResource("hitPoints", Number(event.target.value))} />
                </Field>
                <Field label="当前魔法 MP" hint={`上限 ${draft.derived.maxMagicPoints}`}>
                  <Input disabled={!canEdit} type="number" min={0} max={draft.derived.maxMagicPoints} value={draft.derived.magicPoints} onChange={(event) => updateCurrentResource("magicPoints", Number(event.target.value))} />
                </Field>
                <Field label="当前理智 SAN" hint={`上限 ${draft.derived.maxSanity}`}>
                  <Input disabled={!canEdit} type="number" min={0} max={draft.derived.maxSanity} value={draft.derived.sanity} onChange={(event) => updateCurrentResource("sanity", Number(event.target.value))} />
                </Field>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                <DerivedValue label="最大 HP" value={draft.derived.maxHitPoints} />
                <DerivedValue label="最大 MP" value={draft.derived.maxMagicPoints} />
                <DerivedValue label="最大 SAN" value={draft.derived.maxSanity} />
                <DerivedValue label="移动力 MOV" value={draft.derived.movementRate} />
                <DerivedValue label="体格" value={draft.derived.build} />
                <DerivedValue label="伤害加值" value={draft.derived.damageBonus} />
              </div>
            </Section>

            <Section id="character-skills" title="3. 常用技能" description="先添加跑团中最常用的技能即可；克苏鲁神话技能会自动降低最大理智。">
              <div className="grid gap-3">
                {draft.skills.map((skill) => (
                  <div key={skill.id} className="grid gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 md:grid-cols-2 xl:grid-cols-[minmax(9rem,1.5fr)_minmax(8rem,1fr)_7rem_7rem_auto_auto] xl:items-end">
                    <Field label="技能名">
                      <Input disabled={!canEdit} maxLength={120} value={skill.name} onChange={(event) => updateSkill(skill.id, (current) => ({ ...current, name: event.target.value }))} />
                    </Field>
                    <Field label="专攻（可选）">
                      <Input
                        disabled={!canEdit}
                        maxLength={120}
                        value={skill.specialization ?? ""}
                        onChange={(event) => updateSkill(skill.id, (current) => {
                          const specialization = event.target.value;
                          if (!specialization) {
                            const { specialization: _removed, ...withoutSpecialization } = current;
                            return withoutSpecialization;
                          }
                          return { ...current, specialization };
                        })}
                      />
                    </Field>
                    <Field label="基础值">
                      <Input disabled={!canEdit} type="number" min={0} max={100} value={skill.baseValue} onChange={(event) => updateSkill(skill.id, (current) => ({ ...current, baseValue: clampInteger(Number(event.target.value), 0, 100) }))} />
                    </Field>
                    <Field label="当前值">
                      <Input disabled={!canEdit} type="number" min={0} max={100} value={skill.value} onChange={(event) => updateSkill(skill.id, (current) => ({ ...current, value: clampInteger(Number(event.target.value), 0, 100) }))} />
                    </Field>
                    <label className="flex h-10 items-center gap-2 text-sm text-zinc-300">
                      <input disabled={!canEdit} type="checkbox" checked={skill.checked} onChange={(event) => updateSkill(skill.id, (current) => ({ ...current, checked: event.target.checked }))} />
                      成长标记
                    </label>
                    <Button disabled={!canEdit} type="button" variant="ghost" className="px-3 text-red-300" aria-label={`删除技能 ${skill.name}`} onClick={() => removeSkill(skill.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                {draft.skills.length === 0 && (
                  <EmptyState>
                    <p>还没有技能。可以一键加入常见调查技能，再按职业和人物特点修改；也可以只添加自己需要的技能。</p>
                    <Button disabled={!canEdit} type="button" variant="secondary" className="mt-3" onClick={addCommonInvestigationSkills}>
                      加入常见调查技能
                    </Button>
                  </EmptyState>
                )}
                <Button disabled={!canEdit || draft.skills.length >= 200} type="button" variant="secondary" className="justify-self-start" onClick={addSkill}>
                  <Plus className="mr-2 h-4 w-4" />添加其他技能
                </Button>
              </div>
            </Section>

            <Section title="伤势与精神状态" description="平时保持收起；受伤或陷入疯狂时再来调整。" collapsible defaultOpen={hasActiveStatus}>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                {(Object.entries(statusLabels) as Array<[StatusKey, string]>).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-3 text-sm text-zinc-300">
                    <input
                      disabled={!canEdit}
                      type="checkbox"
                      checked={draft.status[key]}
                      onChange={(event) => editDraft((current) => ({ ...current, status: { ...current.status, [key]: event.target.checked } }))}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </Section>

            <Section title="物品与装备" description="可以开团后边调查边记录。" collapsible defaultOpen={draft.inventory.length > 0}>
              <div className="grid gap-3">
                {draft.inventory.map((item) => (
                  <div key={item.id} className="grid gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 md:grid-cols-[minmax(10rem,1fr)_7rem_auto_auto] md:items-end">
                    <Field label="物品名">
                      <Input disabled={!canEdit} maxLength={160} value={item.name} onChange={(event) => updateInventoryItem(item.id, (current) => ({ ...current, name: event.target.value }))} />
                    </Field>
                    <Field label="数量">
                      <Input disabled={!canEdit} type="number" min={0} value={item.quantity} onChange={(event) => updateInventoryItem(item.id, (current) => ({ ...current, quantity: Math.max(0, Math.trunc(Number(event.target.value))) }))} />
                    </Field>
                    <label className="flex h-10 items-center gap-2 text-sm text-zinc-300">
                      <input disabled={!canEdit} type="checkbox" checked={item.equipped} onChange={(event) => updateInventoryItem(item.id, (current) => ({ ...current, equipped: event.target.checked }))} />
                      已装备
                    </label>
                    <Button disabled={!canEdit} type="button" variant="ghost" className="px-3 text-red-300" aria-label={`删除物品 ${item.name}`} onClick={() => removeInventoryItem(item.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                    <div className="md:col-span-4">
                      <Field label="描述">
                        <Textarea disabled={!canEdit} maxLength={4_000} className="min-h-20 w-full" value={item.description} onChange={(event) => updateInventoryItem(item.id, (current) => ({ ...current, description: event.target.value }))} />
                      </Field>
                    </div>
                  </div>
                ))}
                {draft.inventory.length === 0 && <EmptyState>尚未添加物品。</EmptyState>}
                <Button disabled={!canEdit || draft.inventory.length >= 500} type="button" variant="secondary" className="justify-self-start" onClick={addInventoryItem}>
                  <Plus className="mr-2 h-4 w-4" />添加物品
                </Button>
              </div>
            </Section>

            <Section title="人物背景（可稍后补）" description="只写能帮助你扮演的内容，不必为了填满表格而编造。" collapsible defaultOpen={backgroundStarted}>
              <div className="grid gap-4 xl:grid-cols-2">
                {backgroundFields.map(([key, label]) => (
                  <Field key={key} label={label}>
                    <Textarea disabled={!canEdit} maxLength={4_000} value={draft.background[key]} onChange={(event) => editDraft((current) => ({ ...current, background: { ...current.background, [key]: event.target.value } }))} />
                  </Field>
                ))}
              </div>
            </Section>

            <Section title={isV2 ? "团友可见的调查笔记" : "调查笔记"} collapsible defaultOpen={draft.notes.trim().length > 0}>
              <Field label={isV2 ? "会随角色卡同步" : "自由记录"}>
                <Textarea disabled={!canEdit} maxLength={20_000} className="min-h-40" value={draft.notes} onChange={(event) => editDraft((current) => ({ ...current, notes: event.target.value }))} />
              </Field>
            </Section>

            <Section title="只给自己看的笔记" description="不会发给房主或其他玩家；备份角色时会一起保存。" collapsible defaultOpen={privateNotes.trim().length > 0}>
              <Field label="仅自己可见">
                <Textarea
                  disabled={!canEdit || !isLocallyOwnedDraft}
                  maxLength={100_000}
                  className="min-h-40"
                  value={privateNotes}
                  onChange={(event) => { setPrivateNotes(event.target.value); setError(undefined); }}
                />
              </Field>
            </Section>

            <div id="character-save-actions" className="sticky bottom-0 grid scroll-mt-6 gap-2 border-t border-zinc-800 bg-panel/95 py-4 backdrop-blur">
              {currentRoom && !selectedRoomCharacter && canEdit && <label className={`flex items-start gap-3 rounded-lg border p-3 text-sm ${characterReady ? "border-amber-900/60 bg-amber-950/15 text-zinc-300" : "border-zinc-800 bg-zinc-950/60 text-zinc-500"}`}>
                <input
                  type="checkbox"
                  className="mt-1"
                  aria-label="已与 KP 确认属性和技能分配"
                  disabled={!characterReady}
                  checked={rulesConfirmed}
                  onChange={(event) => setRulesConfirmed(event.target.checked)}
                />
                <span><b className="font-medium text-zinc-200">带入房间前确认</b><span className="mt-1 block text-xs leading-5 text-zinc-500">我已按本团采用的方式生成属性、分配职业/兴趣技能，并与 KP 核对。应用只检查基本字段，不会冒充完成规则校验。</span></span>
              </label>}
              <div className="flex flex-wrap items-center gap-3">
                {isLocallyOwnedDraft && (
                  <Button
                    variant={currentRoom ? "secondary" : "primary"}
                    onClick={() => void saveToPersonalLibrary()}
                    disabled={!canEdit || !personalNeedsSave}
                  >
                    {savingTarget === "personal" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}{savingTarget === "personal" ? "正在保存到角色库…" : "保存到我的角色库"}
                  </Button>
                )}
                {currentRoom && (
                  <Button
                    onClick={() => void saveToCurrentRoom()}
                    disabled={!canEdit || !session || roomPaused || roomVersionConflict || !roomNeedsSync || (!selectedRoomCharacter && (!characterReady || !rulesConfirmed))}
                  >
                    {savingTarget === "room" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                    {savingTarget === "room" ? "正在等待房间确认…" : selectedRoomCharacter
                      ? session && !session.isHost && isLocallyOwnedDraft ? "更新并回到现场" : "更新当前房间角色卡"
                      : session && !session.isHost ? "带入并回到现场" : "带入当前房间"}
                  </Button>
                )}
                {dirty && canEdit && <span className="text-sm text-amber-200">有尚未保存的修改</span>}
                {error && <span className="max-w-2xl text-sm text-red-400">{error}</span>}
              </div>
              {currentRoom && isLocallyOwnedDraft && (
                <p className="text-xs text-zinc-500">
                  “保存到我的角色库”只存本机；“{selectedRoomCharacter ? "更新房间角色卡" : "带入房间"}”会让团友看到角色卡，但私密笔记始终只留给你。
                </p>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

async function readCoccharAvatar(assetId: string) {
  const descriptor = await verifyManagedAsset(assetId);
  if (!descriptor.mediaType.startsWith("image/")) throw new Error("角色头像资源不是图片");
  const bytes = new Uint8Array(descriptor.byteLength);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await readManagedAssetChunk(assetId, offset, Math.min(24 * 1024, bytes.byteLength - offset));
    if (result.bytes.byteLength === 0) throw new Error("读取角色头像时资源库提前结束");
    bytes.set(result.bytes, offset);
    offset += result.bytes.byteLength;
    if (result.eof && offset !== bytes.byteLength) throw new Error("角色头像长度与描述符不一致");
  }
  return { descriptor, bytes };
}

function Section({
  id,
  title,
  description,
  children,
  collapsible = false,
  defaultOpen = false,
}: {
  id?: string;
  title: string;
  description?: string;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  if (collapsible) {
    return (
      <details id={id} open={defaultOpen || undefined} className="group scroll-mt-6 rounded-xl border border-zinc-800 bg-zinc-950/25 px-4 py-3">
        <summary className="cursor-pointer list-none">
          <span className="flex items-start justify-between gap-3">
            <span>
              <span className="block font-semibold text-zinc-200">{title}</span>
              {description && <span className="mt-1 block text-xs leading-5 text-zinc-500">{description}</span>}
            </span>
            <span className="shrink-0 rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400">
              <span className="group-open:hidden">展开填写</span>
              <span className="hidden group-open:inline">收起</span>
            </span>
          </span>
        </summary>
        <div className="mt-4 border-t border-zinc-800 pt-4">{children}</div>
      </details>
    );
  }
  return (
    <section id={id} className="scroll-mt-6">
      <div className="mb-3">
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="mt-1 text-xs text-zinc-500">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function ReadinessStep({ ready, label, pending }: { ready: boolean; label: string; pending: string }) {
  return (
    <li className={`rounded-lg border px-3 py-2 ${
      ready
        ? "border-emerald-900/60 bg-emerald-950/20 text-emerald-200"
        : "border-zinc-800 bg-zinc-950/45 text-zinc-300"
    }`}>
      <div className="font-medium">{label}</div>
      <div className="mt-0.5 text-xs opacity-75">{ready ? "可以使用" : pending}</div>
    </li>
  );
}

function DerivedValue({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 font-mono text-xl text-zinc-100">{value}</div>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-5 text-sm text-zinc-500">{children}</div>;
}

function createSkill(): Skill {
  return {
    id: `skill-${crypto.randomUUID()}`,
    name: "新技能",
    baseValue: 0,
    value: 0,
    checked: false,
  };
}

function commonInvestigationSkills(dexterity: number): Skill[] {
  const values: Array<[name: string, value: number]> = [
    ["侦查", 25],
    ["聆听", 20],
    ["图书馆使用", 20],
    ["心理学", 10],
    ["说服", 10],
    ["潜行", 20],
    ["闪避", Math.floor(dexterity / 2)],
    ["斗殴", 25],
    ["急救", 30],
  ];
  return values.map(([name, value]) => ({
    id: `skill-${crypto.randomUUID()}`,
    name,
    baseValue: value,
    value,
    checked: false,
  }));
}

function createInventoryItem(): InventoryItem {
  return {
    id: `item-${crypto.randomUUID()}`,
    name: "新物品",
    quantity: 1,
    description: "",
    equipped: false,
  };
}

function createCharacter(ownerPeerId: string, playerName: string): Coc7Character {
  const now = new Date().toISOString();
  const characteristics: Coc7Character["characteristics"] = {
    str: 50,
    con: 50,
    siz: 50,
    dex: 50,
    app: 50,
    int: 50,
    pow: 50,
    edu: 50,
    luck: 50,
  };
  const skills: Coc7Character["skills"] = [];
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    ownerPeerId,
    name: "新调查员",
    playerName,
    occupation: "",
    age: 25,
    residence: "",
    birthplace: "",
    characteristics,
    derived: deriveCoc7Stats({ characteristics, age: 25, skills }),
    skills,
    status: {
      temporaryInsanity: false,
      indefiniteInsanity: false,
      majorWound: false,
      dying: false,
      unconscious: false,
    },
    inventory: [],
    background: {
      personalDescription: "",
      ideologyAndBeliefs: "",
      significantPeople: "",
      meaningfulLocations: "",
      treasuredPossessions: "",
      traits: "",
      injuriesAndScars: "",
      phobiasAndManias: "",
      arcaneTomesSpellsAndArtifacts: "",
      encountersWithStrangeEntities: "",
    },
    notes: "",
    updatedAt: now,
    extensions: {},
  };
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  const finite = Number.isFinite(value) ? Math.trunc(value) : minimum;
  return Math.min(maximum, Math.max(minimum, finite));
}

function safeCharacterFileName(value: string): string {
  const safe = value.trim().replace(/[<>:"/\\|?*]/g, "_");
  return safe || "investigator";
}

function characterDraftSnapshot(character: Coc7Character, privateNotes: string): string {
  return JSON.stringify({ character, privateNotes });
}

function roomCharacterSnapshot(character: Coc7Character): string {
  return JSON.stringify({ ...character, updatedAt: "" });
}

const CHARACTER_DRAFT_STORAGE_PREFIX = "coc-room:character-draft:v1:";
const MAX_CHARACTER_DRAFT_STORAGE_CHARS = 512 * 1024;
const MAX_PRIVATE_NOTES_CHARS = 100_000;

function characterDraftStorageScope(roomId: string | undefined, localOwnerId: string | undefined): string {
  return roomId
    ? `room:${roomId}:seat:${localOwnerId ?? "unbound"}`
    : "personal";
}

function characterDraftStorageKey(scope: string): string {
  return `${CHARACTER_DRAFT_STORAGE_PREFIX}${encodeURIComponent(scope)}`;
}

function readRecoverableCharacterDraft(scope: string): RecoverableCharacterDraftV1 | undefined {
  const storage = safeSessionStorage();
  if (!storage) return undefined;
  const key = characterDraftStorageKey(scope);
  try {
    const raw = storage.getItem(key);
    if (!raw) return undefined;
    if (raw.length > MAX_CHARACTER_DRAFT_STORAGE_CHARS) {
      storage.removeItem(key);
      return undefined;
    }
    const candidate: unknown = JSON.parse(raw);
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("invalid draft envelope");
    const record = candidate as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const version = record.version;
    const expectedKeys = version === 2
      ? ["baseRoomUpdatedAt", "character", "privateNotes", "savedAt", "scope", "version"]
      : ["character", "privateNotes", "savedAt", "scope", "version"];
    if (keys.join("\u0000") !== expectedKeys.sort().join("\u0000")) {
      throw new Error("unexpected draft fields");
    }
    if ((version !== 1 && version !== 2) || record.scope !== scope) throw new Error("draft scope mismatch");
    if (typeof record.privateNotes !== "string" || record.privateNotes.length > MAX_PRIVATE_NOTES_CHARS) {
      throw new Error("invalid private notes");
    }
    if (typeof record.savedAt !== "string" || !Number.isFinite(Date.parse(record.savedAt))) {
      throw new Error("invalid savedAt");
    }
    if (
      version === 2
      && record.baseRoomUpdatedAt !== null
      && record.baseRoomUpdatedAt !== "unknown"
      && (typeof record.baseRoomUpdatedAt !== "string" || !Number.isFinite(Date.parse(record.baseRoomUpdatedAt)))
    ) throw new Error("invalid room baseline");
    return {
      version,
      scope,
      character: coc7CharacterSchema.parse(record.character),
      privateNotes: record.privateNotes,
      savedAt: record.savedAt,
      ...(version === 2 ? { baseRoomUpdatedAt: record.baseRoomUpdatedAt as string | null | "unknown" } : {}),
    };
  } catch {
    try { storage.removeItem(key); } catch { /* Session storage can be disabled by the browser. */ }
    return undefined;
  }
}

function writeRecoverableCharacterDraft(
  scope: string,
  character: Coc7Character,
  privateNotes: string,
  baseRoomUpdatedAt: string | null | "unknown",
): void {
  const storage = safeSessionStorage();
  if (!storage || privateNotes.length > MAX_PRIVATE_NOTES_CHARS) return;
  const key = characterDraftStorageKey(scope);
  try {
    const payload: RecoverableCharacterDraftV1 = {
      version: 2,
      scope,
      character: coc7CharacterSchema.parse(character),
      privateNotes,
      savedAt: new Date().toISOString(),
      baseRoomUpdatedAt,
    };
    const raw = JSON.stringify(payload);
    if (raw.length > MAX_CHARACTER_DRAFT_STORAGE_CHARS) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, raw);
  } catch {
    // Recovery is best-effort and must never block editing or leak draft content to logs.
  }
}

function clearRecoverableCharacterDraftByKey(key: string): void {
  const storage = safeSessionStorage();
  if (!storage) return;
  try { storage.removeItem(key); } catch { /* Session storage can be disabled by the browser. */ }
}

function safeSessionStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
