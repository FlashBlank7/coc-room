import type { ModulePackageV1, ScenePublicEntityV1 } from "@coc-room/protocol";
import { publicEntityVariantKey } from "../../lib/scene-publications";
import { GuideNote } from "./KeeperPreparationReader";
import { Button } from "../ui/Button";

export function SceneEntityGuidance({ name, entries, text, legacyText, onChoose, disabled, modulePackage, compact = false }: {
  name: string; entries: ScenePublicEntityV1[]; text: string; legacyText?: string;
  onChoose?(text: string, name?: string): void; disabled?: boolean; modulePackage: ModulePackageV1; compact?: boolean;
}) {
  const matched = entries.filter((entry) => entry.text.trim() === text.trim());
  const references = matched.length ? matched : entries;
  return <div aria-label={`${compact ? "成组登场参考" : "本幕登场参考"}：${name}`} className="mt-2 grid gap-2 text-xs">
    {entries.length === 0 ? <p className="text-amber-200/80">尚未按这一幕整理介绍，可先整理本幕或直接手写。</p> : <>
      {!matched.length && text.trim() && <p className="text-amber-200/80">正文已手动调整，以下条件供你对照。</p>}
      {!text.trim() && entries.length > 1 && <p className="text-amber-200/80">同一人物或地点有不同登场时机，请按当前进展选一个版本。</p>}
      {references.map((entry) => <div key={publicEntityVariantKey(entry)} className="grid gap-2">
        {compact ? <p className="whitespace-pre-wrap text-amber-200/80">登场条件：{entry.when.text}</p> : <GuideNote note={entry.when} modulePackage={modulePackage} />}
        {!matched.length && !compact && <p className="whitespace-pre-wrap leading-5 text-zinc-300">{entry.name && <b>{entry.name}： </b>}{entry.text || "此时暂不介绍这个人物或地点。"}</p>}
        {onChoose && entry.text && entry.text.trim() !== text.trim() && <Button variant="secondary" disabled={disabled} onClick={() => onChoose(entry.text, entry.name)}>采用本幕介绍：{name}</Button>}
      </div>)}
    </>}
    {!compact && legacyText?.trim() && legacyText.trim() !== text.trim() && <details className="text-zinc-500"><summary className="cursor-pointer">查看以前的介绍（未按本幕核对）</summary><p className="mt-2 whitespace-pre-wrap leading-5">{legacyText}</p><p className="mt-1">它可能包含后续剧情，先核对此刻是否已知。</p>{onChoose && <Button variant="ghost" disabled={disabled} onClick={() => onChoose(legacyText)}>复制旧介绍后修改</Button>}</details>}
  </div>;
}
