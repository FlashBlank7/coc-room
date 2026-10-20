import { Button } from "../ui/Button";

export interface HostCharacterDraftRequest {
  jobId: string;
  requesterSeatId: string;
  requesterName: string;
  playerName: string;
  prompt: string;
}

export function HostCharacterRequests({ requests, disabled = false, onApprove, onReject }: {
  requests: readonly HostCharacterDraftRequest[];
  disabled?: boolean;
  onApprove?(jobId: string): void;
  onReject?(jobId: string): void;
}) {
  if (!requests.length) return null;
  return <section aria-label="AI 车卡申请" className="mb-4 grid gap-3 rounded-xl border border-amber-800/60 bg-amber-950/15 p-4">
    <h2 className="text-sm font-semibold text-amber-100">AI 车卡申请 · {requests.length}</h2>
    <p className="text-xs leading-5 text-zinc-400">同意后使用你的 AI 生成草稿，结果直接交给玩家；角色仍需按本团要求检查。</p>
    {requests.map((request) => <article key={request.jobId} className="grid gap-2 rounded-lg bg-black/20 p-3 text-sm">
      <b>{request.requesterName}{request.playerName !== request.requesterName ? `（${request.playerName}）` : ""}</b>
      <details><summary className="cursor-pointer text-xs text-zinc-400">想生成：{Array.from(request.prompt).slice(0, 80).join("")}{Array.from(request.prompt).length > 80 ? "…" : ""}</summary><p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-xs leading-5">{request.prompt}</p></details>
      <div className="flex gap-2">
        <Button disabled={disabled || !onApprove} onClick={() => onApprove?.(request.jobId)}>同意并开始生成</Button>
        <Button disabled={disabled || !onReject} variant="ghost" onClick={() => onReject?.(request.jobId)}>拒绝</Button>
      </div>
    </article>)}
  </section>;
}
