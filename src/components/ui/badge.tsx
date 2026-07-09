import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors [&>svg]:size-3 [&>svg]:pointer-events-none focus-visible:ring-2 focus-visible:ring-cyan-300/40 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "border-cyan-400/25 bg-cyan-400/10 text-cyan-200 [a&]:hover:bg-cyan-400/15",
        secondary:
          "border-zinc-700/70 bg-zinc-900/80 text-zinc-300 [a&]:hover:bg-zinc-800",
        destructive:
          "border-red-500/25 bg-red-500/10 text-red-200 [a&]:hover:bg-red-500/15 focus-visible:ring-red-300/40",
        outline:
          "border-white/10 bg-white/[0.025] text-zinc-300 [a&]:hover:bg-white/[0.055] [a&]:hover:text-white",
        ghost: "border-transparent text-zinc-400 [a&]:hover:bg-white/[0.045] [a&]:hover:text-white",
        link: "border-transparent text-cyan-300 underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
