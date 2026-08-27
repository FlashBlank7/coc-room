import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export const buttonVariants = cva(
  "inline-flex h-10 items-center justify-center whitespace-nowrap rounded-md px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        primary: "bg-brass text-zinc-950 hover:bg-amber-300",
        secondary: "border border-zinc-700 bg-zinc-800 text-ink hover:bg-zinc-700",
        danger: "bg-danger text-white hover:bg-red-500",
        ghost: "text-zinc-300 hover:bg-zinc-800",
      },
    },
    defaultVariants: {
      variant: "primary",
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ asChild = false, className, variant, ...props }, ref) => {
    const Component = asChild ? Slot : "button";
    return <Component ref={ref} className={cn(buttonVariants({ variant }), className)} {...props} />;
  },
);
Button.displayName = "Button";
