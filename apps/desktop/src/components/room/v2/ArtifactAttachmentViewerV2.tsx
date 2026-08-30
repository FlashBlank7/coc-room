import { useEffect, useMemo, useState } from "react";
import {
  type AssetDescriptorV1,
  type RoomArtifactV2,
  type RoomEntityV2,
} from "@coc-room/protocol";

import {
  hasManagedAssetStore,
  resolveManagedAssetUrl,
} from "../../../lib/asset-store";

export type ResolveRoomAssetV2 = (asset: AssetDescriptorV1) => Promise<string>;

interface ArtifactAttachmentViewerV2Props {
  readonly artifact: Pick<RoomArtifactV2, "title" | "attachments" | "asset">;
  readonly resolveAsset?: ResolveRoomAssetV2;
  readonly compact?: boolean;
}

/**
 * Read-only presentation for assets that already belong to a projected room
 * artifact. This component deliberately accepts an artifact instead of a raw
 * asset ID so callers cannot use it as an unrestricted asset-store browser.
 */
export function ArtifactAttachmentViewerV2({
  artifact,
  resolveAsset,
  compact = false,
}: ArtifactAttachmentViewerV2Props) {
  const assets = useMemo(() => artifactAssetsV2(artifact), [artifact.asset, artifact.attachments]);
  if (assets.length === 0) return null;

  return <div
    className={`grid ${compact ? "mt-2 gap-2" : "mt-3 gap-3"}`}
    aria-label={`${artifact.title}的附件`}
  >
    {assets.map((asset, index) => <ResolvedArtifactAttachmentV2
      key={asset.assetId}
      asset={asset}
      artifactTitle={artifact.title}
      index={index}
      resolveAsset={resolveAsset}
      compact={compact}
    />)}
  </div>;
}

interface VisibleEntityArtifactMediaV2Props {
  readonly entity: Pick<RoomEntityV2, "name" | "artifactIds">;
  /** The caller must pass the current seat's projected world map. */
  readonly artifacts: ReadonlyMap<string, RoomArtifactV2>;
  readonly resolveAsset?: ResolveRoomAssetV2;
  readonly compact?: boolean;
}

/**
 * Shows media explicitly attached to a visible entity. Missing artifact IDs
 * are ignored: in a player projection that is how secret artifacts remain
 * opaque, and importantly no resolver call is made for them.
 */
export function VisibleEntityArtifactMediaV2({
  entity,
  artifacts,
  resolveAsset,
  compact = true,
}: VisibleEntityArtifactMediaV2Props) {
  const visibleArtifacts = entity.artifactIds
    .map((artifactId) => artifacts.get(artifactId))
    .filter((artifact): artifact is RoomArtifactV2 => Boolean(artifact))
    .filter((artifact) => !artifact.archived)
    .filter((artifact) => artifactAssetsV2(artifact).length > 0);
  if (visibleArtifacts.length === 0) return null;

  return <div aria-label={`${entity.name}的可见附件`}>
    {visibleArtifacts.map((artifact) => <ArtifactAttachmentViewerV2
      key={artifact.artifactId}
      artifact={artifact}
      resolveAsset={resolveAsset}
      compact={compact}
    />)}
  </div>;
}

function ResolvedArtifactAttachmentV2({
  asset,
  artifactTitle,
  index,
  resolveAsset,
  compact,
}: {
  readonly asset: AssetDescriptorV1;
  readonly artifactTitle: string;
  readonly index: number;
  readonly resolveAsset?: ResolveRoomAssetV2;
  readonly compact: boolean;
}) {
  const resolution = useResolvedArtifactAssetV2(asset, resolveAsset);
  const [mediaFailed, setMediaFailed] = useState(false);
  const ordinal = index + 1;
  const filename = attachmentFilename(artifactTitle, asset, ordinal);
  const label = attachmentKindLabel(asset);

  useEffect(() => setMediaFailed(false), [asset.assetId, resolution.url]);

  if (resolution.state === "loading") {
    return <div role="status" className={fallbackClassName(compact)}>
      <span className="font-medium text-zinc-300">正在载入{label}</span>
      <span className="text-zinc-600">{attachmentMetadata(asset)}</span>
    </div>;
  }

  if (resolution.state === "unavailable" || resolution.state === "error" || !resolution.url || mediaFailed) {
    return <div role="status" className={fallbackClassName(compact)}>
      <span className="font-medium text-amber-200">{label}暂时无法载入</span>
      <span className="text-zinc-500">
        {resolution.state === "unavailable"
          ? "当前浏览器没有连接到本地资源库"
          : "资源可能仍在传输；稍后可重新打开此页重试"}
      </span>
      <span className="text-zinc-600">{attachmentMetadata(asset)}</span>
    </div>;
  }

  if (asset.mediaType.startsWith("image/")) {
    return <figure className="overflow-hidden rounded-lg border border-zinc-800 bg-black/25">
      <a href={resolution.url} target="_blank" rel="noreferrer" aria-label={`打开原图：${artifactTitle}`}>
        <img
          src={resolution.url}
          alt={`${artifactTitle}，图片附件 ${ordinal}`}
          className={`w-full object-contain ${compact ? "max-h-56" : "max-h-[32rem]"}`}
          loading="lazy"
          onError={() => setMediaFailed(true)}
        />
      </a>
      <figcaption className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[11px] text-zinc-500">
        <span>{attachmentMetadata(asset)}</span>
        <a className="font-medium text-brass hover:underline" href={resolution.url} download={filename}>下载图片</a>
      </figcaption>
    </figure>;
  }

  if (asset.mediaType.startsWith("audio/")) {
    return <div className="grid gap-2 rounded-lg border border-zinc-800 bg-black/20 p-3">
      <audio
        className="w-full"
        controls
        preload="metadata"
        src={resolution.url}
        aria-label={`${artifactTitle}，音频附件 ${ordinal}`}
        onError={() => setMediaFailed(true)}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-500">
        <span>{attachmentMetadata(asset)}</span>
        <a className="font-medium text-brass hover:underline" href={resolution.url} download={filename}>下载音频</a>
      </div>
    </div>;
  }

  return <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-black/20 p-3 text-xs">
    <div>
      <p className="font-medium text-zinc-300">{label}</p>
      <p className="mt-1 text-[11px] text-zinc-600">{attachmentMetadata(asset)}</p>
    </div>
    <a
      className="rounded-md border border-brass/40 px-3 py-2 font-medium text-brass hover:bg-brass/10"
      href={resolution.url}
      download={filename}
      target="_blank"
      rel="noreferrer"
    >
      打开或下载文件
    </a>
  </div>;
}

function useResolvedArtifactAssetV2(
  asset: AssetDescriptorV1,
  resolveAsset?: ResolveRoomAssetV2,
): { readonly state: "loading" | "ready" | "error" | "unavailable"; readonly url?: string } {
  const [resolution, setResolution] = useState<{
    readonly assetId: string;
    readonly state: "loading" | "ready" | "error" | "unavailable";
    readonly url?: string;
  }>({ assetId: asset.assetId, state: "loading" });

  useEffect(() => {
    let cancelled = false;
    if (!resolveAsset && !hasManagedAssetStore()) {
      setResolution({ assetId: asset.assetId, state: "unavailable" });
      return () => { cancelled = true; };
    }
    setResolution({ assetId: asset.assetId, state: "loading" });
    const operation = Promise.resolve().then(() => resolveAsset
      ? resolveAsset(asset)
      : resolveManagedAssetUrl(asset.assetId));
    void operation.then((url) => {
      if (cancelled) return;
      setResolution(url
        ? { assetId: asset.assetId, state: "ready", url }
        : { assetId: asset.assetId, state: "error" });
    }).catch(() => {
      if (!cancelled) setResolution({ assetId: asset.assetId, state: "error" });
    });
    return () => { cancelled = true; };
  }, [asset.assetId, resolveAsset]);

  if (resolution.assetId !== asset.assetId) return { state: "loading" };
  return resolution;
}

function artifactAssetsV2(
  artifact: Pick<RoomArtifactV2, "attachments" | "asset">,
): AssetDescriptorV1[] {
  const values = [...artifact.attachments, ...(artifact.asset ? [artifact.asset] : [])];
  return values.filter((asset, index) => values.findIndex(({ assetId }) => assetId === asset.assetId) === index);
}

function attachmentKindLabel(asset: AssetDescriptorV1): string {
  if (asset.mediaType.startsWith("image/")) return "图片附件";
  if (asset.mediaType.startsWith("audio/")) return "音频附件";
  return "文件附件";
}

function attachmentMetadata(asset: AssetDescriptorV1): string {
  const dimensions = asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : "";
  const duration = asset.durationMs !== undefined ? ` · ${formatDuration(asset.durationMs)}` : "";
  return `${asset.mediaType} · ${formatByteLength(asset.byteLength)}${dimensions}${duration}`;
}

function attachmentFilename(title: string, asset: AssetDescriptorV1, ordinal: number): string {
  const safeTitle = title.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_") || "coc-room-attachment";
  return `${safeTitle}-${ordinal}.${extensionForMediaType(asset.mediaType)}`;
}

function extensionForMediaType(mediaType: string): string {
  const known: Record<string, string> = {
    "image/webp": "webp",
    "image/png": "png",
    "image/jpeg": "jpg",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "application/pdf": "pdf",
    "text/plain": "txt",
    "text/markdown": "md",
  };
  return known[mediaType.toLowerCase()] ?? mediaType.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") ?? "bin";
}

function formatByteLength(byteLength: number): string {
  if (byteLength < 1024 * 1024) return `${Math.max(0.1, byteLength / 1024).toFixed(1)} KiB`;
  return `${(byteLength / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function fallbackClassName(compact: boolean): string {
  return `grid rounded-lg border border-dashed border-zinc-700 bg-black/20 text-xs leading-5 ${compact ? "gap-0.5 p-2" : "gap-1 p-3"}`;
}
