import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Check, Image, Loader2, PackagePlus, Upload } from "lucide-react";

import type { AssetDescriptorV1, ModulePackageV1 } from "@coc-room/protocol";

import {
  addManagedAssetReference,
  importManagedAssetBytes,
  resolveManagedAssetUrl,
  type ImportedAssetV1,
} from "../../lib/asset-store";
import {
  moduleSourceImages,
  withImportedModuleSourceImage,
  type ModuleSourceImageItem,
} from "../../lib/module-source-assets";
import { extractValidatedSourceArchiveImages } from "../../lib/source-archive-assets";
import { Button } from "../ui/Button";

interface PreparedImage {
  readonly source: ModuleSourceImageItem;
  readonly bytes: Uint8Array;
  readonly previewUrl: string;
}

export function ModuleSourceAssetsPanel({
  modulePackage,
  sourceFile,
  onChange,
  onError,
  importAsset = (bytes, mediaType) => importManagedAssetBytes("image", bytes, mediaType),
  addReference = addManagedAssetReference,
}: {
  readonly modulePackage: ModulePackageV1;
  readonly sourceFile?: File;
  readonly onChange: (next: ModulePackageV1) => void;
  readonly onError?: (message?: string) => void;
  /** Test seam; production imports into the managed content-addressed store. */
  readonly importAsset?: (bytes: Uint8Array, mediaType: string) => Promise<ImportedAssetV1>;
  /** Test seam for the managed-store ownership record. */
  readonly addReference?: typeof addManagedAssetReference;
}) {
  const parsedSummary = useMemo<
    | { readonly ok: true; readonly summary: ReturnType<typeof moduleSourceImages> }
    | { readonly ok: false; readonly error: string }
  >(() => {
    try {
      return { ok: true, summary: moduleSourceImages(modulePackage) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, [modulePackage]);
  const summary = parsedSummary.ok
    ? parsedSummary.summary
    : { items: [] as readonly ModuleSourceImageItem[], importedCount: 0, pendingCount: 0 };
  const [prepared, setPrepared] = useState<PreparedImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const preparedRef = useRef<PreparedImage[]>([]);
  const sourceSignature = summary.items.map(({ sha256 }) => sha256).join("\0");

  const replacePrepared = (next: PreparedImage[]) => {
    for (const current of preparedRef.current) URL.revokeObjectURL(current.previewUrl);
    preparedRef.current = next;
    setPrepared(next);
  };

  useEffect(() => () => {
    for (const current of preparedRef.current) URL.revokeObjectURL(current.previewUrl);
    preparedRef.current = [];
  }, []);

  useEffect(() => {
    replacePrepared([]);
    setLocalError(undefined);
    if (!sourceFile || !/\.zip$/iu.test(sourceFile.name) || summary.pendingCount === 0) return;
    let cancelled = false;
    void prepareArchive(sourceFile, summary.items).then((next) => {
      if (cancelled) {
        for (const current of next) URL.revokeObjectURL(current.previewUrl);
        return;
      }
      replacePrepared(next);
      setLocalError(undefined);
    }).catch(() => {
      // The selected parsing source may belong to a module the keeper just
      // left. A mismatch is not a module error; the explicit reselect action
      // below reports validation failures when the keeper actually asks.
    });
    return () => { cancelled = true; };
    // Imported status changes must not decompress the source again. Hashes and
    // the selected immutable File are the recovery identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceFile, sourceSignature]);

  if (!parsedSummary.ok) return <section role="alert" className="mb-4 rounded-xl border border-red-900/60 bg-red-950/20 p-4 text-xs leading-5 text-red-200">
    源图片清单无法读取：{parsedSummary.error}。可在“高级数据”中修正或删除该扩展；其他模组内容没有受影响。
  </section>;
  if (summary.items.length === 0) return null;

  const chooseArchive = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setLocalError(undefined);
    onError?.(undefined);
    try {
      if (!/\.zip$/iu.test(file.name)) throw new Error("请选择最初用于解析的 ZIP 文件");
      const next = await prepareArchive(file, summary.items);
      replacePrepared(next);
    } catch (error) {
      const message = friendlyArchiveError(error);
      setLocalError(message);
      onError?.(message);
    } finally {
      setBusy(false);
    }
  };

  const importImages = async (sources: readonly ModuleSourceImageItem[]) => {
    if (busy) return;
    const requested = sources.flatMap((source) => {
      const match = prepared.find((item) => item.source.sha256 === source.sha256);
      return match ? [match] : [];
    });
    if (requested.length !== sources.length) {
      setLocalError("请先重新选择最初的源 ZIP，确认图片预览后再收入素材库");
      return;
    }
    setBusy(true);
    setLocalError(undefined);
    onError?.(undefined);
    try {
      let next = modulePackage;
      for (const image of requested) {
        const imported = await importAsset(image.bytes, image.source.mediaType);
        next = withImportedModuleSourceImage(next, image.source, imported.asset);
        await addReference({
          assetId: imported.asset.assetId,
          ownerType: "module",
          ownerId: modulePackage.moduleId,
          ownerRevision: modulePackage.revision,
          slot: `source-image:${image.source.sha256}`,
        });
      }
      onChange(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLocalError(`图片没有收入模组素材库：${message}`);
      onError?.(message);
    } finally {
      setBusy(false);
    }
  };

  const pending = summary.items.filter((item) => !item.importedAsset);
  return (
    <section aria-label="源 ZIP 图片素材" className="mb-4 rounded-xl border border-sky-900/60 bg-sky-950/15 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-sky-100"><Image className="h-4 w-4" />源 ZIP 图片</div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-zinc-400">
            先在 KP 本机检查，再决定是否收入备团素材。收入素材不会设成背景，也不会发给玩家；进入房间后仍要预览并确认公开。
          </p>
        </div>
        <span className="rounded-full border border-sky-800/60 px-2 py-1 text-[10px] text-sky-200">
          {summary.importedCount}/{summary.items.length} 已收入素材
        </span>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {summary.items.map((item, index) => {
          const ready = prepared.find((candidate) => candidate.source.sha256 === item.sha256);
          return <article key={item.sha256} className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/70">
            {ready ? <img src={ready.previewUrl} alt={`源图片 ${index + 1} 预览`} className="h-36 w-full bg-zinc-950 object-contain" />
              : item.importedAsset ? <ManagedImagePreview asset={item.importedAsset} alt={`已收入的源图片 ${index + 1}`} />
              : <div className="grid h-36 place-items-center bg-zinc-950 text-xs text-zinc-600">重新选择原 ZIP 后可预览</div>}
            <div className="grid gap-2 p-3">
              <div>
                <p className="text-xs font-medium text-zinc-200">源图片 {index + 1}</p>
                <p className="mt-0.5 text-[10px] text-zinc-500">{item.width} × {item.height} · {formatBytes(item.byteLength)} · {item.mediaType}</p>
              </div>
              {item.importedAsset ? <p className="flex items-center gap-1 text-[11px] text-emerald-300"><Check className="h-3.5 w-3.5" />已收入备团素材 · 尚未公开</p>
                : <Button type="button" variant="secondary" className="h-8 text-xs" disabled={busy || !ready} onClick={() => void importImages([item])}>
                  {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <PackagePlus className="mr-1.5 h-3.5 w-3.5" />}
                  收入这张素材
                </Button>}
            </div>
          </article>;
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-800">
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
          {prepared.length > 0 ? "重新核对源 ZIP" : "选择原 ZIP 以检查图片"}
          <input aria-label="重新选择包含源图片的 ZIP" className="hidden" type="file" accept=".zip,application/zip" disabled={busy} onChange={(event) => void chooseArchive(event)} />
        </label>
        {pending.length > 1 && <Button type="button" disabled={busy || prepared.length < pending.length} onClick={() => void importImages(pending)}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PackagePlus className="mr-2 h-4 w-4" />}
          把 {pending.length} 张全部收入素材
        </Button>}
      </div>
      {localError && <p role="alert" className="mt-3 text-xs leading-5 text-red-300">{localError}</p>}
    </section>
  );
}

function ManagedImagePreview({ asset, alt }: { asset: AssetDescriptorV1; alt: string }) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setUrl(undefined);
    setFailed(false);
    void resolveManagedAssetUrl(asset.assetId).then((next) => {
      if (!cancelled) setUrl(next);
    }).catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => { cancelled = true; };
  }, [asset.assetId]);
  if (url) return <img src={url} alt={alt} className="h-36 w-full bg-zinc-950 object-contain" />;
  return <div className="grid h-36 place-items-center bg-zinc-950 text-xs text-zinc-600">{failed ? "本机素材暂时无法读取" : "正在读取本机素材…"}</div>;
}

async function prepareArchive(file: File, expected: readonly ModuleSourceImageItem[]): Promise<PreparedImage[]> {
  if (file.size < 1 || file.size > 25 * 1024 * 1024) throw new Error("源 ZIP 为空或超过 25 MiB 上限");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const images = await extractValidatedSourceArchiveImages(bytes, expected);
  return images.map((image) => {
    const blobBytes = new Uint8Array(image.bytes.byteLength);
    blobBytes.set(image.bytes);
    return {
      ...image,
      previewUrl: URL.createObjectURL(new Blob([blobBytes.buffer], { type: image.source.mediaType })),
    };
  });
}

function friendlyArchiveError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `没有打开源 ZIP 图片：${detail}。AI 整理结果仍然保留，可以稍后再选原文件。`;
}

function formatBytes(byteLength: number): string {
  if (byteLength < 1_024) return `${byteLength} B`;
  if (byteLength < 1_024 * 1_024) return `${Math.round(byteLength / 1_024)} KiB`;
  return `${(byteLength / (1_024 * 1_024)).toFixed(1)} MiB`;
}
