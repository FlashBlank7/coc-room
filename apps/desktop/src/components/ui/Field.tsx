import type { ReactNode } from "react";
import { Label } from "./Label";
export { Input } from "./Input";
export { Textarea } from "./Textarea";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <Label className="grid gap-1.5 text-sm text-zinc-300">
      <span className="font-medium text-zinc-200">{label}</span>
      {children}
      {hint && <span className="text-xs text-zinc-500">{hint}</span>}
    </Label>
  );
}
