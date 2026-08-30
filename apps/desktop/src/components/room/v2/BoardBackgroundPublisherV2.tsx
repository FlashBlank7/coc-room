import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, RotateCcw, Send, X } from "lucide-react";
import type { AssetDescriptorV1 } from "@coc-room/protocol";

import {
  resolveManagedAssetUrl,
  selectAndImportAsset,
  type ImportedAssetV1,
} from "../../../lib/asset-store";
import { Button } from "../../ui/Button";

type BackgroundDraftState = {
  readonly asset: AssetDescriptorV1;
  readonly previewUrl: string;
};

export interface BoardBackgroundPublisherV2Props {
  readonly boardName: string;
  readonly hasPublishedBackground: boolean;
  readonly disabled?: boolean;
  readonly onPublish: (asset: AssetDescriptorV1) => Promise<void>;
  readonly onError?: (message?: string) => void;
  /** Already-managed, KP-only preparation assets from the active module. */
  readonly availableAssets?: readonly {
    readonly asset: AssetDescriptorV1;
    readonly label: string;
  }[];
  /** Test seam; production always uses the managed local asset store. */
  readonly selectAsset?: () => Promise<ImportedAssetV1 | undefined>;
  /** Test seam; production resolves the just-imported local asset. */
  readonly resolvePreview?: (asset: AssetDescriptorV1) => Promise<string>;
  /** Reuses the same local-only review flow for a visible room entity. */
  readonly publicationKind?: "board-background" | "entity-image";
}

type BackgroundDraftOperation = "idle" | "selecting" | "publishing";

/**
 * Keeps a newly selected background local until the keeper explicitly
 * confirms publication. Merely importing and previewing an asset must never
 * create a room event or reveal its descriptor to another seat.
 */
export function BoardBackgroundPublisherV2({
  boardName,
  hasPublishedBackground,
  disabled = false,
  onPublish,
  onError,
  availableAssets = [],
  selectAsset = () => selectAndImportAsset("image"),
  resolvePreview = (asset) => resolveManagedAssetUrl(asset.assetId),
  publicationKind = "board-background",
}: BoardBackgroundPublisherV2Props) {
  const [draft, setDraft] = useState<BackgroundDraftState>();
  const [operation, setOperation] = useState<BackgroundDraftOperation>("idle");
  const [localError, setLocalError] = useState<string>();
  const chooseButtonRef = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const entityImage = publicationKind === "entity-image";
  const previewLabel = entityImage ? "待绑定实体图片" : "待发布背景图";
  const confirmLabel = entityImage ? "确认绑定并公开" : "确认公开背景";

  useEffect(() => {
    if (draft) previewRef.current?.focus();
  }, [draft?.asset.assetId]);

  const prepareDraft = async (asset: AssetDescriptorV1) => {
    const previewUrl = await resolvePreview(asset);
    setDraft({ asset, previewUrl });
  };

  const choose = async () => {
    if (disabled || operation !== "idle") return;
    setOperation("selecting");
    setLocalError(undefined);
    onError?.(undefined);
    try {
      const imported = await selectAsset();
      if (!imported) return;
      await prepareDraft(imported.asset);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLocalError(`没有准备好${entityImage ? "图片" : "背景"}预览：${message}`);
    } finally {
      setOperation("idle");
    }
  };

  const choosePrepared = async (asset: AssetDescriptorV1) => {
    if (disabled || operation !== "idle") return;
    setOperation("selecting");
    setLocalError(undefined);
    onError?.(undefined);
    try {
      await prepareDraft(asset);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLocalError(`这张模组素材暂时无法预览：${message}`);
    } finally {
      setOperation("idle");
    }
  };

  const discard = () => {
    if (operation !== "idle") return;
    setDraft(undefined);
    setLocalError(undefined);
    globalThis.setTimeout(() => chooseButtonRef.current?.focus(), 0);
  };

  const publish = async () => {
    if (!draft || disabled || operation !== "idle") return;
    setOperation("publishing");
    setLocalError(undefined);
    onError?.(undefined);
    try {
      await onPublish(draft.asset);
      setDraft(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLocalError(`${entityImage ? "图片没有绑定" : "背景没有公开"}，预览仍保留在本机：${message}`);
      onError?.(message);
    } finally {
      setOperation("idle");
    }
  };

  const selecting = operation === "selecting";
  const publishing = operation === "publishing";
  const busy = operation !== "idle";

  return (
    <div className="grid justify-items-end gap-2">
      {!draft && <div className="flex flex-wrap justify-end gap-2">
        {availableAssets.length > 0 && <details className="rounded-md border border-zinc-800 bg-zinc-950/80 p-1.5 text-left">
          <summary className="cursor-pointer select-none px-1 text-xs text-zinc-300">从模组素材选择（{availableAssets.length}）</summary>
          <div className="mt-2 grid max-h-48 min-w-64 gap-1 overflow-y-auto border-t border-zinc-800 pt-2">
            {availableAssets.map(({ asset, label }, index) => <button
              key={asset.assetId}
              type="button"
              disabled={disabled || busy}
              aria-label={`预览模组素材：${label}`}
              className="rounded-md px-2 py-2 text-left text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
              onClick={() => void choosePrepared(asset)}
            >
              <span className="block font-medium text-zinc-200">{label || `模组图片 ${index + 1}`}</span>
              <span className="mt-0.5 block text-[10px] text-zinc-500">
                {asset.width && asset.height ? `${asset.width} × ${asset.height} · ` : ""}{formatBytes(asset.byteLength)}
              </span>
            </button>)}
          </div>
        </details>}
        <Button
          ref={chooseButtonRef}
          type="button"
          aria-label={entityImage
            ? hasPublishedBackground ? "选择新的实体图片" : "选择实体图片"
            : hasPublishedBackground ? "选择新背景图" : "选择背景图"}
          disabled={disabled || operation !== "idle"}
          variant="secondary"
          onClick={() => void choose()}
        >
          {selecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ImagePlus className="mr-2 h-4 w-4" />}
          {selecting ? "正在准备本地预览…" : hasPublishedBackground ? "从电脑选择新图" : "从电脑选择图片"}
        </Button>
      </div>}

      {!draft && <p className="max-w-lg text-right text-[11px] leading-5 text-zinc-500">
        无论来自模组素材还是电脑，都先在本机预览；点击“{confirmLabel}”前，玩家不会收到这张图或它的资源描述。
      </p>}

      {draft && <section
        ref={previewRef}
        tabIndex={-1}
        aria-label={previewLabel}
        className="w-full max-w-lg rounded-xl border border-amber-700/60 bg-amber-950/20 p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-amber-100">本地预览 · 尚未公开</p>
            <p className="mt-1 text-xs leading-5 text-zinc-400">
              请确认这张图适合“{boardName}”。只有确认后才会发送给{entityImage ? "能看见这项内容的成员" : "当前画面的可见成员"}。
            </p>
          </div>
          <span className="shrink-0 rounded-full border border-amber-700/60 px-2 py-0.5 text-[10px] font-semibold text-amber-200">仅 KP 可见</span>
        </div>
        <img
          src={draft.previewUrl}
          alt={`${boardName}的${entityImage ? "待绑定图片" : "待发布背景"}预览`}
          className="mt-3 max-h-64 w-full rounded-lg border border-zinc-800 bg-zinc-950 object-contain"
        />
        <p className="mt-2 text-[11px] text-zinc-500">
          {draft.asset.width && draft.asset.height ? `${draft.asset.width} × ${draft.asset.height} · ` : ""}
          {formatBytes(draft.asset.byteLength)} · {draft.asset.mediaType}
        </p>
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button type="button" disabled={busy} variant="ghost" onClick={() => void choose()}>
            {selecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
            {selecting ? "正在准备新预览…" : "选择另一张"}
          </Button>
          <Button type="button" disabled={busy} variant="ghost" onClick={discard}>
            <X className="mr-2 h-4 w-4" />放弃预览
          </Button>
          <Button type="button" disabled={busy} onClick={() => void publish()}>
            {publishing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            {publishing ? entityImage ? "正在绑定图片…" : "正在公开背景…" : confirmLabel}
          </Button>
        </div>
      </section>}

      {localError && <p role="alert" className="max-w-lg text-right text-xs leading-5 text-red-300">{localError}</p>}
    </div>
  );
}

function formatBytes(byteLength: number): string {
  if (byteLength < 1_024) return `${byteLength} B`;
  if (byteLength < 1_024 * 1_024) return `${Math.round(byteLength / 1_024)} KiB`;
  return `${(byteLength / (1_024 * 1_024)).toFixed(1)} MiB`;
}
