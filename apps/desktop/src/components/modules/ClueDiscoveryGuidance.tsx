import type { ModulePackageV1 } from "@coc-room/protocol";
import { clueDiscoveryForText, publicClueVariantKey } from "../../lib/clue-discovery";
import { GuideNote } from "./KeeperPreparationReader";

/** Keeper-only context. Publication continues to use only the chosen public text. */
export function ClueDiscoveryGuidance({ modulePackage, clueId, publicText, compact = false }: {
  modulePackage: ModulePackageV1; clueId: string; publicText: string; compact?: boolean;
}) {
  const { drafts, needsReview } = clueDiscoveryForText(modulePackage, clueId, publicText);
  if (!drafts.length) return null;
  return <div className="grid gap-2" aria-label={`发现条件：${modulePackage.clues.find((clue) => clue.id === clueId)?.name ?? clueId}`}>
    <p className="text-[11px] text-amber-200">仅 KP · 先核对发现条件</p>
    {needsReview && <p className="text-xs text-amber-200">当前公开正文与草稿不同，请对照下列版本核对发现条件。</p>}
    {drafts.length > 1 && <p className="text-xs text-zinc-400">以下是不同的发现途径，按玩家实际经过核对。</p>}
    {drafts.map((draft) => <div key={publicClueVariantKey(draft)} className="grid gap-1">
      {compact ? <p className="text-xs leading-5 text-amber-200/80">{draft.when.title}：{draft.when.text}</p> : <GuideNote note={draft.when} modulePackage={modulePackage} />}
      {needsReview && <p className="whitespace-pre-wrap text-xs leading-5 text-zinc-400">对应公开草稿：{draft.text}</p>}
    </div>)}
  </div>;
}
