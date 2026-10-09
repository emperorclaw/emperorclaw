"use client";

import { cn } from "@/lib/utils";

/** Compact visual switch with a full touch target and native keyboard behavior. */
export function SettingsSwitch({ checked, onChange, label, disabled }: {
    checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean;
}) {
    return <button type="button" role="switch" aria-checked={checked} aria-label={label}
        disabled={disabled} onClick={() => onChange(!checked)}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40">
        <span aria-hidden="true" className={cn("relative h-5 w-9 rounded-full transition-colors", checked ? "bg-primary" : "bg-muted-foreground/40")}>
            <span className={cn("absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform", checked && "translate-x-4")} />
        </span>
    </button>;
}
