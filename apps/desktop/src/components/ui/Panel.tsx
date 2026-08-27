import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { Card } from "./Card";

export const Panel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <Card ref={ref} className={cn("p-5", className)} {...props} />,
);
Panel.displayName = "Panel";
