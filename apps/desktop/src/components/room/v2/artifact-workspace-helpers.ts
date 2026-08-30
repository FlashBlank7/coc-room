import type { AssetDescriptorV1 } from "@coc-room/protocol";

/** Deterministic field-level three-way merge; ambiguous edits stay explicit. */
export function mergeTextFieldV2(base: string, ours: string, theirs: string): string {
  if (ours === theirs) return ours;
  if (ours === base) return theirs;
  if (theirs === base) return ours;
  return `${ours}\n\n—— 另一位成员刚保存的内容 ——\n${theirs}`;
}

/** Three-way merge for attachment sets; simultaneous additions are kept. */
export function mergeAttachmentsV2(
  base: readonly AssetDescriptorV1[],
  ours: readonly AssetDescriptorV1[],
  theirs: readonly AssetDescriptorV1[],
  compatibilityAsset?: AssetDescriptorV1,
): AssetDescriptorV1[] {
  if (sameAssetList(ours, theirs)) return withoutCompatibilityAssetV2(ours, compatibilityAsset);
  if (sameAssetList(ours, base)) return withoutCompatibilityAssetV2(theirs, compatibilityAsset);
  if (sameAssetList(theirs, base)) return withoutCompatibilityAssetV2(ours, compatibilityAsset);
  const removedByOurs = new Set(base.filter((asset) => !ours.some(({ assetId }) => assetId === asset.assetId)).map(({ assetId }) => assetId));
  const removedByTheirs = new Set(base.filter((asset) => !theirs.some(({ assetId }) => assetId === asset.assetId)).map(({ assetId }) => assetId));
  const merged = [...ours, ...theirs].filter((asset) => !removedByOurs.has(asset.assetId) && !removedByTheirs.has(asset.assetId));
  return withoutCompatibilityAssetV2(uniqueAssets(merged), compatibilityAsset).slice(0, 32);
}

export function withoutCompatibilityAssetV2(
  attachments: readonly AssetDescriptorV1[],
  compatibilityAsset?: AssetDescriptorV1,
): AssetDescriptorV1[] {
  return compatibilityAsset
    ? attachments.filter(({ assetId }) => assetId !== compatibilityAsset.assetId)
    : [...attachments];
}

function uniqueAssets(assets: readonly AssetDescriptorV1[]): AssetDescriptorV1[] {
  const byId = new Map<string, AssetDescriptorV1>();
  for (const asset of assets) if (!byId.has(asset.assetId)) byId.set(asset.assetId, asset);
  return [...byId.values()];
}

function sameAssetList(left: readonly AssetDescriptorV1[], right: readonly AssetDescriptorV1[]): boolean {
  return left.length === right.length && left.every((asset, index) => asset.assetId === right[index]?.assetId);
}
