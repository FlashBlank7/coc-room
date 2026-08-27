import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "peer flex min-h-28 w-full rounded-md border border-zinc-700 bg-zinc-950 p-3 text-sm text-ink outline-none transition-colors placeholder:text-zinc-600 focus-visible:border-brass focus-visible:ring-2 focus-visible:ring-brass/30 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
