import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-foreground placeholder:text-zinc-500 selection:bg-cyan-400/25 selection:text-white border-white/10 h-10 w-full min-w-0 rounded-xl border bg-white/[0.035] px-3 py-1 text-base text-zinc-100 shadow-sm transition-[border-color,background-color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-cyan-300/60 focus-visible:bg-white/[0.055] focus-visible:ring-2 focus-visible:ring-cyan-300/20",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  );
}

export { Input };
