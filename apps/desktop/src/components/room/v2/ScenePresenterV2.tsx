import { useEffect, useState } from "react";
import { Clapperboard } from "lucide-react";
import type { RoomEntityV2, RoomWorldStateV2 } from "@coc-room/protocol";

import type { RoomSessionV2 } from "../../../network/RoomSessionV2";
import { Button } from "../../ui/Button";
import { Field, Input, Textarea } from "../../ui/Field";

export function ManualScenePresenterV2({
  world,
  session,
  readOnly = false,
  onError,
}: {
  readonly world: RoomWorldStateV2;
  readonly session: RoomSessionV2;
  readonly readOnly?: boolean;
  readonly onError?: (message?: string) => void;
}) {
  const active = world.activeSceneEntityId
    ? world.entities.get(world.activeSceneEntityId)
    : undefined;
  const activeManualScene = active?.kind === "scene" && active.data.roomRole === "manual-current-scene"
    ? active
    : undefined;
  const [title, setTitle] = useState(activeManualScene?.name ?? "");
  const [description, setDescription] = useState(activeManualScene?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [publishedNotice, setPublishedNotice] = useState<string>();

  useEffect(() => {
    setTitle(activeManualScene?.name ?? "");
    setDescription(activeManualScene?.description ?? "");
  }, [activeManualScene?.entityId, activeManualScene?.revision]);

  const present = async () => {
    if (busy || readOnly || !session.isHost) return;
    const nextTitle = title.trim();
    const nextDescription = description.trim();
    if (!nextTitle || !nextDescription) return;
    setBusy(true);
    setPublishedNotice(undefined);
    onError?.(undefined);
    try {
      const entity: RoomEntityV2 = activeManualScene
        ? {
            ...activeManualScene,
            revision: activeManualScene.revision + 1,
            name: nextTitle,
            description: nextDescription,
          }
        : {
            schemaVersion: 2,
            entityId: crypto.randomUUID(),
            revision: 1,
            kind: "scene",
            name: nextTitle,
            description: nextDescription,
            artifactIds: [],
            audience: { kind: "room" },
            data: { roomRole: "manual-current-scene" },
            extensions: {},
          };
      await session.submitConfirmed({
        type: "entity.upserted",
        audience: entity.audience,
        payload: { entity },
      });
      if (world.activeSceneEntityId !== entity.entityId) {
        await session.submitConfirmed({
          type: "scene.focused",
          audience: entity.audience,
          payload: { sceneEntityId: entity.entityId },
        });
      }
      setPublishedNotice(activeManualScene
        ? `“${nextTitle}”的最新描述已经公开给所有玩家。`
        : `“${nextTitle}”已经成为所有玩家看到的当前情境。`);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const complete = Boolean(title.trim() && description.trim());
  const changed = title.trim() !== (activeManualScene?.name ?? "")
    || description.trim() !== (activeManualScene?.description ?? "");
  const buttonLabel = busy
    ? "正在公开……"
    : activeManualScene
      ? changed ? "把更新公开给所有玩家" : "当前描述已是最新"
      : "把开场公开给所有玩家";

  return <section id="manual-scene-presenter" className="grid scroll-mt-4 gap-3 rounded-lg border border-brass/30 bg-brass/5 p-3" aria-label="即兴呈现当前情境">
    <div>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100"><Clapperboard className="h-4 w-4 text-brass" />即兴描述当前情境</h3>
      <p id="manual-scene-help" className="mt-1 text-xs leading-5 text-zinc-500">没有准备模组或画面也能直接开场。这里只写调查员此刻能看见、听见或感受到的事；点击公开前，输入仅留在 KP 这一侧。</p>
      {activeManualScene && <p className="mt-2 rounded-md border border-emerald-900/50 bg-emerald-950/20 px-2.5 py-2 text-xs text-emerald-200">玩家当前看到：{activeManualScene.name}</p>}
    </div>
    <form className="grid gap-3" aria-describedby="manual-scene-help" onSubmit={(event) => { event.preventDefault(); void present(); }}>
      <Field label="这幕叫什么"><Input aria-label="当前情境名称" value={title} maxLength={240} onChange={(event) => { setTitle(event.target.value); setPublishedNotice(undefined); }} placeholder="例如：雨夜的剧院后门" /></Field>
      <Field label="玩家此刻感知到什么"><Textarea aria-label="当前情境公开描述" value={description} maxLength={8_000} onChange={(event) => { setDescription(event.target.value); setPublishedNotice(undefined); }} placeholder="例如：铁皮棚被雨点敲得发响，门缝透出暖黄灯光……" /></Field>
      <Button type="submit" disabled={busy || readOnly || !session.isHost || !complete || !changed}>{buttonLabel}</Button>
      {!complete && <p className="text-xs text-zinc-500">填写标题和玩家可见描述后，才能公开这一幕。</p>}
      {publishedNotice && <p role="status" className="rounded-md border border-emerald-900/50 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-200">{publishedNotice}</p>}
    </form>
  </section>;
}
