import {
  assetDescriptorV1Schema,
  modulePackageSchema,
  type AssetDescriptorV1,
  type ModulePackageV1,
} from "@coc-room/protocol";

import { storedCocmodContents, withStoredCocmodContents } from "./cocmod-package";
import type { ParserSourceAttachment } from "./module-parser";

export const SOURCE_ATTACHMENTS_NAMESPACE = "org.coc-room.source-attachments.v1";

export interface ModuleSourceImageItem extends ParserSourceAttachment {
  readonly importedAsset?: AssetDescriptorV1;
}

export interface ModuleSourceImageSummary {
  readonly items: readonly ModuleSourceImageItem[];
  readonly importedCount: number;
  readonly pendingCount: number;
}

export function moduleSourceImages(candidate: ModulePackageV1): ModuleSourceImageSummary {
  const modulePackage = modulePackageSchema.parse(candidate);
  const extension = modulePackage.extensions[SOURCE_ATTACHMENTS_NAMESPACE];
  if (extension === undefined) return { items: [], importedCount: 0, pendingCount: 0 };
  if (!isRecord(extension) || !Array.isArray(extension.items)) {
    throw new Error("模组中的源图片清单格式无效");
  }
  const seen = new Set<string>();
  const items = extension.items.map((candidateItem) => parseSourceImage(candidateItem)).filter((item) => {
    if (seen.has(item.sha256)) return false;
    seen.add(item.sha256);
    return true;
  });
  const importedCount = items.filter((item) => item.importedAsset !== undefined).length;
  return { items, importedCount, pendingCount: items.length - importedCount };
}

/** Adds a normalized local image to module preparation without publishing it. */
export function withImportedModuleSourceImage(
  candidate: ModulePackageV1,
  source: ParserSourceAttachment,
  importedCandidate: AssetDescriptorV1,
): ModulePackageV1 {
  const modulePackage = modulePackageSchema.parse(candidate);
  const importedAsset = assetDescriptorV1Schema.parse(importedCandidate);
  if (importedAsset.mediaType !== "image/webp") throw new Error("源图片必须先规范化为静态 WebP 资源");
  const summary = moduleSourceImages(modulePackage);
  if (!summary.items.some((item) => item.sha256 === source.sha256.toLowerCase())) {
    throw new Error("这张图片不在当前模组的已验证源素材清单中");
  }
  const items = summary.items.map((item) => item.sha256 === source.sha256.toLowerCase()
    ? { ...item, importedAsset }
    : item);
  const importedCount = items.filter((item) => item.importedAsset !== undefined).length;
  const withSourceStatus = modulePackageSchema.parse({
    ...modulePackage,
    extensions: {
      ...modulePackage.extensions,
      [SOURCE_ATTACHMENTS_NAMESPACE]: {
        status: importedCount === items.length ? "imported_unbound" : "partially_imported",
        items,
      },
    },
  });
  const stored = storedCocmodContents(withSourceStatus);
  const assets = [...stored.assets];
  if (!assets.some(({ assetId }) => assetId === importedAsset.assetId)) {
    assets.push({ ...importedAsset, extension: extensionForAsset(importedAsset) });
  }
  return withStoredCocmodContents(withSourceStatus, { boards: stored.boards, assets });
}

function parseSourceImage(candidate: unknown): ModuleSourceImageItem {
  if (!isRecord(candidate)) throw new Error("模组中的源图片条目格式无效");
  const { importedAsset: importedCandidate } = candidate;
  const item: ParserSourceAttachment = {
    kind: candidate.kind === "image" ? "image" : invalid("源素材不是图片"),
    sha256: typeof candidate.sha256 === "string" && /^[a-f0-9]{64}$/iu.test(candidate.sha256)
      ? candidate.sha256.toLowerCase()
      : invalid("源图片哈希无效"),
    mediaType: typeof candidate.mediaType === "string" && /^image\/(?:gif|jpeg|png|webp)$/u.test(candidate.mediaType)
      ? candidate.mediaType
      : invalid("源图片格式无效"),
    byteLength: positiveInteger(candidate.byteLength, "源图片长度无效"),
    width: positiveInteger(candidate.width, "源图片宽度无效"),
    height: positiveInteger(candidate.height, "源图片高度无效"),
  };
  return {
    ...item,
    ...(importedCandidate === undefined ? {} : { importedAsset: assetDescriptorV1Schema.parse(importedCandidate) }),
  };
}

function extensionForAsset(asset: AssetDescriptorV1): string {
  switch (asset.mediaType) {
    case "image/webp": return "webp";
    default: throw new Error(`模组包不支持图片格式 ${asset.mediaType}`);
  }
}

function positiveInteger(value: unknown, message: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(message);
  return Number(value);
}

function invalid(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
