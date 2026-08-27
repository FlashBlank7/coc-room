import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm text-zinc-300">
      <span className="font-medium text-zinc-200">{label}</span>
      {children}
      {hint && <span className="text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn("h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-ink outline-none focus:border-brass", className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn("min-h-28 rounded-md border border-zinc-700 bg-zinc-950 p-3 text-sm text-ink outline-none focus:border-brass", className)} {...props} />;
}
