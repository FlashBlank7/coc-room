import type { KeeperPreparationV1, ModulePackageV1 } from "@coc-room/protocol";

export type PublicClueDraft = NonNullable<KeeperPreparationV1["publicClues"]>[number];

/** One clue can reveal different information through different routes. */
export function publicClueVariantKey(clue: PublicClueDraft): string {
  return JSON.stringify([clue.clueId, clue.text, clue.when.text]);
}

export function clueDiscoveryForText(modulePackage: ModulePackageV1, clueId: string, publicText: string) {
  const variants = modulePackage.keeperGuide?.preparation?.publicClues?.filter((draft) => draft.clueId === clueId) ?? [];
  const matching = variants.filter((draft) => draft.text.trim() === publicText.trim());
  // A manual edit may change what is safe to reveal. Keep every original route
  // available for comparison instead of assigning the first route arbitrarily.
  return { drafts: matching.length ? matching : variants, needsReview: variants.length > 0 && matching.length === 0 };
}
