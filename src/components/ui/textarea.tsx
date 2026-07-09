import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "placeholder:text-zinc-500 selection:bg-cyan-400/25 selection:text-white flex min-h-20 field-sizing-content w-full rounded-xl border border-white/10 bg-white/[0.035] px-3 py-2 text-base text-zinc-100 shadow-sm transition-[border-color,background-color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-cyan-300/60 focus-visible:bg-white/[0.055] focus-visible:ring-2 focus-visible:ring-cyan-300/20",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
