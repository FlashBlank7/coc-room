import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
};

export function Button({ className, variant = "primary", ...props }: Props) {
  return (
    <button
      className={cn(
        "inline-flex h-10 items-center justify-center rounded-md px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40",
        variant === "primary" && "bg-brass text-zinc-950 hover:bg-amber-300",
        variant === "secondary" && "border border-zinc-700 bg-zinc-800 text-ink hover:bg-zinc-700",
        variant === "danger" && "bg-danger text-white hover:bg-red-500",
        variant === "ghost" && "text-zinc-300 hover:bg-zinc-800",
        className,
      )}
      {...props}
    />
  );
}
