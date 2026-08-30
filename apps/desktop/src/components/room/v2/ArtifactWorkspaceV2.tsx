import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  type AssetDescriptorV1,
  type AudienceV2,
  type RoomArtifactV2,
  type RoomWorldStateV2,
  type SeatV2,
} from "@coc-room/protocol";

import {
  addManagedAssetReference,
  hasManagedAssetStore,
  selectAndImportAsset,
  type ImportedAssetV1,
} from "../../../lib/asset-store";
import { RoomCommandRejectedError, type RoomSessionV2 } from "../../../network/RoomSessionV2";
import { Button } from "../../ui/Button";
import { Field, Input, Textarea } from "../../ui/Field";
import { Panel } from "../../ui/Panel";
import {
  mergeAttachmentsV2,
  mergeTextFieldV2,
  withoutCompatibilityAssetV2,
} from "./artifact-workspace-helpers";
import {
  ArtifactAttachmentViewerV2,
  type ResolveRoomAssetV2,
} from "./ArtifactAttachmentViewerV2";

export { mergeAttachmentsV2, mergeTextFieldV2 } from "./artifact-workspace-helpers";

interface ArtifactWorkspaceV2Props {
  readonly world: RoomWorldStateV2;
  readonly session?: RoomSessionV2;
  readonly readOnly?: boolean;
  readonly onError?: (message?: string) => void;
  /**
   * `supporting-materials` is used beside the public case file: public clues
   * are rendered there once, while private clues remain reachable here.
   */
  readonly listMode?: "all-editable" | "supporting-materials";
  readonly heading?: string;
  readonly description?: string;
  readonly emptyMessage?: string;
  /** Test/preview seam; production uses the native content-addressed store. */
  readonly assetPickerAvailable?: boolean;
  readonly selectAsset?: (kind: "image" | "audio") => Promise<ImportedAssetV1 | undefined>;
  readonly retainAssetReference?: typeof addManagedAssetReference;
  /** Resolves only descriptors already present in this seat's projected world. */
  readonly resolveAsset?: ResolveRoomAssetV2;
}

interface EditableArtifactSnapshot {
  readonly base: RoomArtifactV2;
  title: string;
  description: string;
  body: string;
  attachments: AssetDescriptorV1[];
  locallyImportedAssetIds: string[];
}

interface ArtifactMergeState {
  readonly base: RoomArtifactV2;
  readonly theirs: RoomArtifactV2;
  readonly ours: Pick<RoomArtifactV2, "title" | "description" | "body" | "attachments">;
  readonly locallyImportedAssetIds: string[];
  title: string;
  description: string;
  body: string;
  attachments: AssetDescriptorV1[];
}

const EDITABLE_KINDS = ["clue", "handout", "note"] as const;

/**
 * Shared Artifact editor. Event-level revision rejection is the lock: the UI
 * never silently overwrites a newer revision and opens a three-way merge when
 * two visible members save from the same baseline.
 */
export function ArtifactWorkspaceV2({
  world,
  session,
  readOnly = false,
  onError,
  listMode = "all-editable",
  heading = "共享资料与线索",
  description = "看得见这项资料的人都可以一起补充；KP 可以锁定或归档。若两人同时保存，会提醒合并。",
  emptyMessage,
  assetPickerAvailable = hasManagedAssetStore(),
  selectAsset = selectAndImportAsset,
  retainAssetReference = addManagedAssetReference,
  resolveAsset,
}: ArtifactWorkspaceV2Props) {
  const matchingArtifacts = useMemo(
    () => [...world.artifacts.values()].filter((artifact) => {
      if (!isEditableArtifactKind(artifact.kind)) return false;
      return belongsInWorkspace(artifact, listMode);
    }),
    [listMode, world.artifacts],
  );
  const artifacts = matchingArtifacts.filter((artifact) => !artifact.archived);
  const archivedArtifacts = matchingArtifacts.filter((artifact) => artifact.archived);
  const [editing, setEditing] = useState<EditableArtifactSnapshot>();
  const [merge, setMerge] = useState<ArtifactMergeState>();
  const [composerOpen, setComposerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newKind, setNewKind] = useState<(typeof EDITABLE_KINDS)[number]>("clue");
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [newAttachments, setNewAttachments] = useState<AssetDescriptorV1[]>([]);
  const [newLocalAssetIds, setNewLocalAssetIds] = useState<string[]>([]);
  const [newSecret, setNewSecret] = useState(world.defaultVisibility === "secret");
  const editingTriggerRef = useRef<HTMLButtonElement | null>(null);
  const editTitleRef = useRef<HTMLInputElement | null>(null);
  const mergeHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const restoreEditingTriggerRef = useRef(false);
  const editingHeadingId = useId();
  const mergeHeadingId = useId();
  const mergeDescriptionId = useId();

  const canSubmit = Boolean(session && !readOnly && session.isAuthenticated);
  const editorFocusKey = merge
    ? `merge:${merge.theirs.artifactId}:${merge.theirs.revision}`
    : editing
      ? `edit:${editing.base.artifactId}:${editing.base.revision}`
      : "closed";

  useEffect(() => {
    if (merge) mergeHeadingRef.current?.focus();
    else if (editing) editTitleRef.current?.focus();
  }, [editorFocusKey]);

  useEffect(() => {
    if (editing || merge || !restoreEditingTriggerRef.current) return;
    restoreEditingTriggerRef.current = false;
    editingTriggerRef.current?.focus();
  }, [editing, merge]);

  const startEdit = (artifact: RoomArtifactV2, trigger: HTMLButtonElement) => {
    editingTriggerRef.current = trigger;
    setMerge(undefined);
    setEditing({
      base: structuredClone(artifact),
      title: artifact.title,
      description: artifact.description,
      body: artifact.body,
      attachments: [...artifact.attachments],
      locallyImportedAssetIds: [],
    });
  };

  const closeEditor = () => {
    restoreEditingTriggerRef.current = true;
    setMerge(undefined);
    setEditing(undefined);
  };

  const handleEditorKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeEditor();
  };

  const importAttachment = async (target: "new" | "editing" | "merge", kind: "image" | "audio") => {
    if (!assetPickerAvailable || busy) return;
    setBusy(true);
    onError?.(undefined);
    try {
      const imported = await selectAsset(kind);
      if (!imported) return;
      if (target === "new") {
        setNewAttachments((current) => appendAttachment(current, imported.asset));
        setNewLocalAssetIds((current) => appendAssetId(current, imported.asset.assetId));
      } else if (target === "editing") {
        setEditing((current) => current && ({
          ...current,
          attachments: appendAttachment(current.attachments, imported.asset, current.base.asset),
          locallyImportedAssetIds: appendAssetId(current.locallyImportedAssetIds, imported.asset.assetId),
        }));
      } else {
        setMerge((current) => current && ({
          ...current,
          attachments: appendAttachment(current.attachments, imported.asset, current.theirs.asset),
          locallyImportedAssetIds: appendAssetId(current.locallyImportedAssetIds, imported.asset.assetId),
        }));
      }
    } catch {
      onError?.("没有添加附件。请确认文件类型和大小符合要求后再试。");
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!session || !editing || busy) return;
    setBusy(true);
    onError?.(undefined);
    const ours = {
      title: editing.title.trim(),
      description: editing.description.trim(),
      body: editing.body,
      attachments: editing.attachments,
    };
    try {
      if (!ours.title) throw new Error("资料标题不能为空");
      if (!hasArtifactContent(ours.body, ours.attachments, editing.base.asset)) {
        throw new Error("资料需要正文或至少一个附件");
      }
      await session.submitConfirmed({
        type: "artifact.upserted",
        audience: editing.base.audience,
        payload: {
          artifact: {
            ...editing.base,
            revision: editing.base.revision + 1,
            ...ours,
          },
        },
      });
      await retainImportedAssets(
        editing.base.artifactId,
        editing.base.revision + 1,
        editing.attachments,
        editing.locallyImportedAssetIds,
        assetPickerAvailable,
        retainAssetReference,
      );
      closeEditor();
    } catch (error) {
      const theirs = session.world.artifacts.get(editing.base.artifactId);
      if (isRevisionConflict(error) && theirs && theirs.revision > editing.base.revision) {
        onError?.(undefined);
        setMerge({
          base: editing.base,
          theirs: structuredClone(theirs),
          ours,
          title: mergeTextFieldV2(editing.base.title, ours.title, theirs.title),
          description: mergeTextFieldV2(
            editing.base.description,
            ours.description,
            theirs.description,
          ),
          body: mergeTextFieldV2(editing.base.body, ours.body, theirs.body),
          attachments: mergeAttachmentsV2(
            editing.base.attachments,
            ours.attachments,
            theirs.attachments,
            theirs.asset,
          ),
          locallyImportedAssetIds: editing.locallyImportedAssetIds,
        });
      } else {
        onError?.(friendlyArtifactError(error, "没有保存修改。你的文字仍留在编辑框中，可以稍后再试。"));
      }
    } finally {
      setBusy(false);
    }
  };

  const saveMerge = async () => {
    if (!session || !merge || busy) return;
    setBusy(true);
    onError?.(undefined);
    try {
      const current = session.world.artifacts.get(merge.theirs.artifactId);
      if (!current) throw new Error("资料已经不存在");
      if (!merge.title.trim()) throw new Error("资料标题不能为空");
      if (!hasArtifactContent(merge.body, merge.attachments, current.asset)) {
        throw new Error("资料需要正文或至少一个附件");
      }
      await session.submitConfirmed({
        type: "artifact.upserted",
        audience: current.audience,
        payload: {
          artifact: {
            ...current,
            revision: current.revision + 1,
            title: merge.title.trim(),
            description: merge.description.trim(),
            body: merge.body,
            attachments: withoutCompatibilityAssetV2(merge.attachments, current.asset),
          },
        },
      });
      await retainImportedAssets(
        current.artifactId,
        current.revision + 1,
        merge.attachments,
        merge.locallyImportedAssetIds,
        assetPickerAvailable,
        retainAssetReference,
      );
      closeEditor();
    } catch (error) {
      const current = session.world.artifacts.get(merge.theirs.artifactId);
      if (isRevisionConflict(error) && current && current.revision > merge.theirs.revision) {
        onError?.(undefined);
        setMerge({
          base: merge.theirs,
          theirs: structuredClone(current),
          ours: {
            title: merge.title,
            description: merge.description,
            body: merge.body,
            attachments: merge.attachments,
          },
          locallyImportedAssetIds: merge.locallyImportedAssetIds,
          title: mergeTextFieldV2(merge.theirs.title, merge.title, current.title),
          description: mergeTextFieldV2(
            merge.theirs.description,
            merge.description,
            current.description,
          ),
          body: mergeTextFieldV2(merge.theirs.body, merge.body, current.body),
          attachments: mergeAttachmentsV2(
            merge.theirs.attachments,
            merge.attachments,
            current.attachments,
            current.asset,
          ),
        });
      } else {
        onError?.(friendlyArtifactError(error, "没有保存合并结果。你整理好的文字仍留在这里，可以稍后再试。"));
      }
    } finally {
      setBusy(false);
    }
  };

  const createArtifact = async () => {
    if (!session || busy) return;
    const title = newTitle.trim();
    const body = newBody.trim();
    if (!title || !hasArtifactContent(body, newAttachments)) {
      return onError?.("新资料需要标题，以及正文或至少一个附件");
    }
    const audience = draftAudience(newSecret, session.localSeat);
    const artifactId = globalThis.crypto.randomUUID();
    setBusy(true);
    onError?.(undefined);
    try {
      await session.submitConfirmed({
        type: "artifact.upserted",
        audience,
        payload: {
          artifact: {
            schemaVersion: 2,
            artifactId,
            revision: 1,
            kind: newKind,
            title,
            description: "",
            body,
            attachments: newAttachments,
            audience,
            locked: false,
            archived: false,
            extensions: {},
          },
        },
      });
      await retainImportedAssets(
        artifactId,
        1,
        newAttachments,
        newLocalAssetIds,
        assetPickerAvailable,
        retainAssetReference,
      );
      setNewTitle("");
      setNewBody("");
      setNewAttachments([]);
      setNewLocalAssetIds([]);
      setComposerOpen(false);
    } catch (error) {
      onError?.(friendlyArtifactError(error, "没有加入这项资料。填写的内容仍留在这里，可以稍后再试。"));
    } finally {
      setBusy(false);
    }
  };

  const updateKeeperState = async (artifact: RoomArtifactV2, change: "locked" | "archived") => {
    if (!session?.isHost || busy) return;
    if (change === "archived" && !artifact.archived && !globalThis.confirm(
      `要把“${artifact.title}”从当前案卷中收起吗？\n\n内容不会删除，之后可以从“已收起的资料”恢复。`,
    )) return;
    setBusy(true);
    onError?.(undefined);
    try {
      await session.submitConfirmed({
        type: "artifact.upserted",
        audience: artifact.audience,
        payload: {
          artifact: {
            ...artifact,
            revision: artifact.revision + 1,
            [change]: !artifact[change],
          },
        },
      });
      if (change === "archived") setEditing(undefined);
    } catch (error) {
      onError?.(friendlyArtifactError(error, "没有完成这次调整，请稍后再试。"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel className="grid gap-4 p-4" aria-label={heading}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-serif text-lg">{heading}</h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-zinc-500">
            {description}
          </p>
        </div>
        {!readOnly && <Button
          type="button"
          variant={composerOpen ? "secondary" : "primary"}
          disabled={!canSubmit || busy}
          aria-expanded={composerOpen}
          onClick={() => setComposerOpen((current) => !current)}
        >
          {composerOpen ? "先不新增" : "新增线索或资料"}
        </Button>}
      </div>

      {!readOnly && !canSubmit && <p role="status" className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs leading-5 text-zinc-500">
        房间连接恢复后，才能新增或修改资料。已经同步到本机的内容仍可查看。
      </p>}

      {!readOnly && composerOpen && <div className="grid gap-3 rounded-lg border border-brass/30 bg-zinc-950/50 p-3 md:grid-cols-[150px_1fr]">
        <div className="md:col-span-2">
          <h3 className="text-sm font-semibold text-zinc-200">记录一项新发现</h3>
          <p className="mt-1 text-xs leading-5 text-zinc-500">先选择谁能看到。公开线索会进入共同案卷；私密内容只留给指定的人。</p>
        </div>
        <select
          aria-label="新资料类型"
          className="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm"
          value={newKind}
          onChange={(event) => setNewKind(event.target.value as (typeof EDITABLE_KINDS)[number])}
        >
          <option value="clue">线索</option>
          <option value="handout">手记</option>
          <option value="note">笔记</option>
        </select>
        <Input aria-label="新资料标题" value={newTitle} maxLength={240} onChange={(event) => setNewTitle(event.target.value)} placeholder="给这项发现起个名字" />
        <fieldset className="grid gap-2 rounded border border-zinc-800 p-3 md:col-span-2">
          <legend className="px-1 text-xs text-zinc-400">谁能看见？</legend>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input type="radio" name="new-artifact-audience" checked={!newSecret} onChange={() => setNewSecret(false)} />
            房间里的所有人
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input type="radio" name="new-artifact-audience" checked={newSecret} onChange={() => setNewSecret(true)} />
            {session?.isHost ? "只给 KP 看，不发给玩家" : "只给我和 KP 看"}
          </label>
        </fieldset>
        <Textarea aria-label="新资料正文" className="min-h-20 md:col-span-2" value={newBody} maxLength={50_000} onChange={(event) => setNewBody(event.target.value)} placeholder="写下线索内容、推理或需要记住的细节" />
        <AttachmentEditor
          attachments={newAttachments}
          disabled={!assetPickerAvailable || busy}
          onAdd={(kind) => void importAttachment("new", kind)}
          onRemove={(assetId) => setNewAttachments((current) => current.filter((asset) => asset.assetId !== assetId))}
        />
        <Button disabled={!canSubmit || busy || !newTitle.trim() || !hasArtifactContent(newBody, newAttachments)} onClick={() => void createArtifact()}>
          {createActionLabel(newKind, newSecret)}
        </Button>
        {listMode === "supporting-materials" && newKind === "clue" && <p className="text-xs leading-5 text-zinc-500 md:col-span-2">
          {newSecret
            ? "这条线索不会进入所有人的共同案卷，只会显示给上面选择的人。"
            : "保存后，这条线索会从这里移到上方共同案卷，让所有玩家看见。"}
        </p>}
      </div>}

      <div className="grid gap-2 md:grid-cols-2">
        {artifacts.length === 0 && <div className="rounded-lg border border-dashed border-zinc-800 p-4 md:col-span-2">
          <p className="text-sm text-zinc-400">{emptyMessage ?? "这里还没有资料。"}</p>
          {!readOnly && canSubmit && <p className="mt-1 text-xs leading-5 text-zinc-600">需要记录新发现时，点“新增线索或资料”。</p>}
          {readOnly && <p className="mt-1 text-xs leading-5 text-zinc-600">之后公开或写下的内容会出现在这里。</p>}
        </div>}
        {artifacts.map((artifact) => {
          const playerLocked = artifact.locked && !session?.isHost;
          return <article key={artifact.artifactId} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold">{artifact.title}</h3>
                <p className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-zinc-500">
                  <span>{artifactKindLabel(artifact.kind)}</span>
                  <span>{artifactAudienceLabel(artifact.audience, session?.localSeat)}</span>
                  {artifact.locked && <span>只读，只有 KP 能修改</span>}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button disabled={!canSubmit || playerLocked} className="text-xs text-brass disabled:text-zinc-700" onClick={(event) => startEdit(artifact, event.currentTarget)}>编辑内容</button>
                {session?.isHost && !readOnly && <>
                  <button disabled={busy} className="text-xs text-zinc-400 disabled:opacity-40" onClick={() => void updateKeeperState(artifact, "locked")}>{artifact.locked ? "允许共同修改" : "设为只读"}</button>
                  <button disabled={busy} className="text-xs text-red-300 disabled:opacity-40" onClick={() => void updateKeeperState(artifact, "archived")}>从当前案卷收起</button>
                </>}
              </div>
            </div>
            {artifact.description && <p className="mt-2 text-xs text-zinc-500">{artifact.description}</p>}
            <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-xs leading-5 text-zinc-300">{artifact.body}</p>
            <ArtifactAttachmentViewerV2 artifact={artifact} resolveAsset={resolveAsset} compact />
          </article>;
        })}
      </div>

      {session?.isHost && archivedArtifacts.length > 0 && <details className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-3">
        <summary className="cursor-pointer text-xs text-zinc-400">已收起的资料 · {archivedArtifacts.length}</summary>
        <p className="mt-2 text-xs leading-5 text-zinc-600">这些内容没有删除，也不会出现在当前案卷中。需要时可以恢复。</p>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {archivedArtifacts.map((artifact) => <div key={artifact.artifactId} className="flex items-center justify-between gap-3 rounded border border-zinc-800 bg-zinc-950 p-2">
            <div className="min-w-0">
              <p className="truncate text-xs text-zinc-300">{artifact.title}</p>
              <p className="mt-0.5 text-[11px] text-zinc-600">{artifactKindLabel(artifact.kind)} · {artifactAudienceLabel(artifact.audience, session.localSeat)}</p>
            </div>
            {!readOnly && <button type="button" disabled={busy} className="shrink-0 text-xs text-brass disabled:opacity-40" onClick={() => void updateKeeperState(artifact, "archived")}>恢复到案卷</button>}
          </div>)}
        </div>
      </details>}

      {editing && !merge && <section aria-labelledby={editingHeadingId} onKeyDown={handleEditorKeyDown} className="grid gap-3 rounded-lg border border-brass/40 bg-zinc-950 p-4">
        <div>
          <h3 id={editingHeadingId} className="text-xs font-semibold text-brass">正在编辑：{editing.base.title}</h3>
          <p className="mt-1 text-[11px] text-zinc-500">保存后仍然是“{artifactAudienceLabel(editing.base.audience, session?.localSeat)}”，不会意外改变可见范围。</p>
        </div>
        <Field label="标题"><Input ref={editTitleRef} value={editing.title} maxLength={240} onChange={(event) => setEditing({ ...editing, title: event.target.value })} /></Field>
        <Field label="摘要"><Textarea className="min-h-16" value={editing.description} maxLength={4_000} onChange={(event) => setEditing({ ...editing, description: event.target.value })} /></Field>
        <Field label="正文"><Textarea value={editing.body} maxLength={50_000} onChange={(event) => setEditing({ ...editing, body: event.target.value })} /></Field>
        <AttachmentEditor
          attachments={editing.attachments}
          disabled={!assetPickerAvailable || busy}
          onAdd={(kind) => void importAttachment("editing", kind)}
          onRemove={(assetId) => setEditing({ ...editing, attachments: editing.attachments.filter((asset) => asset.assetId !== assetId) })}
        />
        <div className="flex gap-2"><Button disabled={busy || !editing.title.trim() || !hasArtifactContent(editing.body, editing.attachments, editing.base.asset)} onClick={() => void saveEdit()}>保存修改</Button><Button variant="secondary" onClick={closeEditor}>取消</Button></div>
      </section>}

      {merge && <section aria-labelledby={mergeHeadingId} aria-describedby={mergeDescriptionId} onKeyDown={handleEditorKeyDown} className="grid gap-3 rounded-lg border border-amber-700/60 bg-amber-950/10 p-4">
        <div role="alert" aria-labelledby={mergeHeadingId} aria-describedby={mergeDescriptionId}><h3 ref={mergeHeadingRef} id={mergeHeadingId} tabIndex={-1} className="rounded-sm font-semibold text-amber-200 outline-none focus:ring-2 focus:ring-amber-400/80">保存前，请先看看另一位成员的修改</h3><p id={mergeDescriptionId} className="mt-1 text-xs leading-5 text-zinc-500">你编辑期间，另一位成员先保存了新内容。我们已把双方文字放进下方编辑框，请删去重复并保留最终版本；任何一方都不会被静默覆盖。</p></div>
        <div className="grid gap-2 lg:grid-cols-3">
          <VersionColumn label="你开始编辑时" title={merge.base.title} body={merge.base.body} />
          <VersionColumn label="另一位成员刚保存的" title={merge.theirs.title} body={merge.theirs.body} />
          <VersionColumn label="你尚未保存的" title={merge.ours.title} body={merge.ours.body} />
        </div>
        <Field label="合并后的标题"><Input value={merge.title} maxLength={240} onChange={(event) => setMerge({ ...merge, title: event.target.value })} /></Field>
        <Field label="合并后的摘要"><Textarea className="min-h-16" value={merge.description} maxLength={4_000} onChange={(event) => setMerge({ ...merge, description: event.target.value })} /></Field>
        <Field label="合并后的正文"><Textarea value={merge.body} maxLength={50_000} onChange={(event) => setMerge({ ...merge, body: event.target.value })} /></Field>
        <AttachmentEditor
          attachments={merge.attachments}
          disabled={!assetPickerAvailable || busy}
          onAdd={(kind) => void importAttachment("merge", kind)}
          onRemove={(assetId) => setMerge({ ...merge, attachments: merge.attachments.filter((asset) => asset.assetId !== assetId) })}
        />
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || !merge.title.trim() || !hasArtifactContent(merge.body, merge.attachments, merge.theirs.asset)} onClick={() => void saveMerge()}>保存整理后的内容</Button>
          <Button variant="secondary" onClick={() => setMerge({ ...merge, title: merge.ours.title, description: merge.ours.description, body: merge.ours.body, attachments: [...merge.ours.attachments] })}>先用我的草稿</Button>
          <Button variant="secondary" onClick={() => setMerge({ ...merge, title: merge.theirs.title, description: merge.theirs.description, body: merge.theirs.body, attachments: [...merge.theirs.attachments] })}>先用对方刚保存的内容</Button>
          <Button variant="ghost" onClick={closeEditor}>取消</Button>
        </div>
      </section>}
    </Panel>
  );
}

function AttachmentEditor({
  attachments,
  disabled,
  onAdd,
  onRemove,
}: {
  readonly attachments: readonly AssetDescriptorV1[];
  readonly disabled: boolean;
  readonly onAdd: (kind: "image" | "audio") => void;
  readonly onRemove: (assetId: string) => void;
}) {
  return <div className="grid gap-2 rounded border border-zinc-800 p-2">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-zinc-500">附件 {attachments.length}/32</span>
      <Button type="button" variant="secondary" disabled={disabled || attachments.length >= 32} onClick={() => onAdd("image")}>添加图片附件</Button>
      <Button type="button" variant="secondary" disabled={disabled || attachments.length >= 32} onClick={() => onAdd("audio")}>添加音频附件</Button>
      {disabled && <span className="text-[11px] text-zinc-600">桌面应用中可选择本地文件</span>}
    </div>
    {attachments.map((asset) => <div key={asset.assetId} className="flex items-center justify-between gap-2 text-[11px] text-zinc-500">
      <span className="min-w-0 truncate">{attachmentLabel(asset)}</span>
      <button type="button" disabled={disabled} className="shrink-0 text-red-300 disabled:text-zinc-700" onClick={() => onRemove(asset.assetId)}>移除</button>
    </div>)}
  </div>;
}

function VersionColumn({ label, title, body }: { label: string; title: string; body: string }) {
  return <div className="min-w-0 rounded border border-zinc-800 bg-zinc-950 p-2 text-xs">
    <b className="text-zinc-400">{label}</b>
    <p className="mt-1 truncate text-zinc-200">{title}</p>
    <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap font-sans text-zinc-600">{body}</pre>
  </div>;
}

function draftAudience(secret: boolean, seat: Pick<SeatV2, "seatId" | "role">): AudienceV2 {
  if (!secret) return { kind: "room" };
  return seat.role === "host" ? { kind: "host" } : { kind: "seats", seatIds: [seat.seatId] };
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof RoomCommandRejectedError
    ? error.code === "CONFLICT"
    : /revision|conflict/i.test(errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendAttachment(
  current: readonly AssetDescriptorV1[],
  next: AssetDescriptorV1,
  compatibilityAsset?: AssetDescriptorV1,
): AssetDescriptorV1[] {
  if (compatibilityAsset?.assetId === next.assetId || current.some(({ assetId }) => assetId === next.assetId)) return [...current];
  if (current.length >= 32) throw new Error("每项资料最多包含 32 个附件");
  return [...current, next];
}

function appendAssetId(current: readonly string[], assetId: string): string[] {
  return current.includes(assetId) ? [...current] : [...current, assetId];
}

function hasArtifactContent(
  body: string,
  attachments: readonly AssetDescriptorV1[],
  compatibilityAsset?: AssetDescriptorV1,
): boolean {
  return Boolean(body.trim() || attachments.length > 0 || compatibilityAsset);
}

function isEditableArtifactKind(kind: RoomArtifactV2["kind"]): kind is (typeof EDITABLE_KINDS)[number] {
  return EDITABLE_KINDS.some((editableKind) => editableKind === kind);
}

function belongsInWorkspace(
  artifact: RoomArtifactV2,
  listMode: ArtifactWorkspaceV2Props["listMode"],
): boolean {
  // KP still needs one place to restore a public clue after it was removed
  // from the live case file.
  if (artifact.archived) return true;
  return listMode !== "supporting-materials"
    || artifact.kind !== "clue"
    || artifact.audience.kind !== "room";
}

function createActionLabel(kind: (typeof EDITABLE_KINDS)[number], secret: boolean): string {
  if (kind === "clue") return secret ? "保存为私密线索" : "公开到调查案卷";
  return secret ? "保存为私密资料" : "加入共享资料";
}

function artifactAudienceLabel(audience: AudienceV2, localSeat?: Pick<SeatV2, "seatId" | "role">): string {
  if (audience.kind === "room") return "所有人可见";
  if (audience.kind === "host") return "仅 KP 可见";
  if (localSeat?.role === "player" && audience.seatIds.includes(localSeat.seatId)) {
    return audience.seatIds.length === 1 ? "只给我和 KP 看" : "给我、指定玩家和 KP 看";
  }
  return "仅指定玩家和 KP 可见";
}

function artifactKindLabel(kind: RoomArtifactV2["kind"]): string {
  switch (kind) {
    case "clue": return "线索";
    case "handout": return "手记";
    case "note": return "笔记";
    default: return "资料";
  }
}

function attachmentLabel(asset: AssetDescriptorV1): string {
  const dimensions = asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : "";
  const kind = asset.mediaType.startsWith("image/")
    ? "图片"
    : asset.mediaType.startsWith("audio/")
      ? "音频"
      : "附件";
  return `${kind} · ${formatByteLength(asset.byteLength)}${dimensions}`;
}

function friendlyArtifactError(error: unknown, fallback: string): string {
  if (error instanceof RoomCommandRejectedError) {
    switch (error.code) {
      case "PAUSED": return "房主暂时离线或连接中断。内容仍留在编辑框中，恢复连接后再试。";
      case "FORBIDDEN": return "你现在不能修改这项资料。它可能只给其他人看，或已被 KP 设为只读。";
      case "CONFLICT": return "另一位成员刚刚更新了这项资料。请重新打开后再修改。";
      case "INVALID": return "这项资料没有通过检查，请确认标题、正文和附件后再试。";
      case "INTERNAL": return fallback;
    }
  }
  if (error instanceof Error && /^(资料标题不能为空|资料需要正文|资料已经不存在|每项资料最多包含)/.test(error.message)) {
    return error.message;
  }
  return fallback;
}

function formatByteLength(byteLength: number): string {
  if (byteLength < 1024 * 1024) return `${Math.max(0.1, byteLength / 1024).toFixed(1)} KiB`;
  return `${(byteLength / (1024 * 1024)).toFixed(1)} MiB`;
}

async function retainImportedAssets(
  artifactId: string,
  revision: number,
  attachments: readonly AssetDescriptorV1[],
  locallyImportedAssetIds: readonly string[],
  available: boolean,
  retain: typeof addManagedAssetReference,
): Promise<void> {
  if (!available || locallyImportedAssetIds.length === 0) return;
  const local = new Set(locallyImportedAssetIds);
  const retained = attachments.filter(({ assetId }) => local.has(assetId));
  await Promise.all(retained.map((asset, index) => retain({
    assetId: asset.assetId,
    ownerType: "artifact",
    ownerId: artifactId,
    ownerRevision: revision,
    slot: `event.attachment.${index}`,
  })));
}
