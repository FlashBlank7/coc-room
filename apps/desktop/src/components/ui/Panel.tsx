import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export function Panel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-xl border border-zinc-800 bg-panel/95 p-5 shadow-xl shadow-black/20", className)} {...props} />;
}
