import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold transition-all duration-200 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "border border-cyan-400/25 bg-cyan-400/12 text-cyan-50 shadow-sm shadow-cyan-950/20 hover:border-cyan-300/45 hover:bg-cyan-400/18",
        destructive:
          "border border-red-500/25 bg-red-500/12 text-red-50 shadow-sm shadow-red-950/20 hover:border-red-400/45 hover:bg-red-500/18 focus-visible:ring-red-300/50",
        outline:
          "border border-white/10 bg-white/[0.035] text-zinc-100 shadow-sm hover:border-white/20 hover:bg-white/[0.065]",
        secondary:
          "border border-zinc-700/70 bg-zinc-900/80 text-zinc-100 hover:border-zinc-600 hover:bg-zinc-800/90",
        ghost:
          "text-zinc-300 hover:bg-white/[0.055] hover:text-white",
        link: "rounded-md px-0 text-cyan-300 underline-offset-4 hover:text-cyan-200 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2 has-[>svg]:px-3",
        xs: "h-7 gap-1 rounded-lg px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 rounded-lg gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-11 rounded-xl px-6 has-[>svg]:px-4",
        icon: "size-10",
        "icon-xs": "size-7 rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 rounded-lg",
        "icon-lg": "size-11 rounded-xl",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
