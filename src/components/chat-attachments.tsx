"use client";

import { IconFile, IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type AttachmentRef = {
    id: string;
    name: string;
    contentType: string;
    sizeBytes: number;
};

export function isAttachmentRef(value: unknown): value is AttachmentRef {
    if (!value || typeof value !== "object") return false;
    const v = value as Record<string, unknown>;
    return typeof v.id === "string" && typeof v.name === "string";
}

/**
 * Renders a file attached to a chat message. Used both for files the user is
 * about to send (onRemove) and files already present on messages (href).
 */
export function AttachmentChip({
    attachment,
    onRemove,
    tone = "dark",
    href,
}: {
    attachment: AttachmentRef;
    onRemove?: () => void;
    tone?: "light" | "dark";
    href?: string;
}) {
    const size = formatBytes(attachment.sizeBytes);
    return (
        <div
            className={cn(
                "group inline-flex min-w-0 max-w-full items-center gap-2 rounded-lg border px-2.5 py-1.5",
                tone === "light"
                    ? "border-emerald-950/20 bg-emerald-950/10"
                    : "border-zinc-800 bg-zinc-900",
            )}
        >
            <IconFile className={cn("h-4 w-4 shrink-0", tone === "light" ? "text-emerald-950/70" : "text-emerald-400")} />
            <div className="min-w-0">
                <div className={cn("truncate text-xs font-medium", tone === "light" ? "text-emerald-950" : "text-zinc-200")}>
                    {attachment.name}
                </div>
                {size && (
                    <div className={cn("text-[10px]", tone === "light" ? "text-emerald-950/60" : "text-zinc-500")}>{size}</div>
                )}
            </div>
            {href ? (
                <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-[10px] font-medium text-emerald-400 hover:text-emerald-300"
                >
                    open
                </a>
            ) : null}
            {onRemove ? (
                <button
                    type="button"
                    onClick={onRemove}
                    aria-label={`Remove ${attachment.name}`}
                    className="shrink-0 rounded-full p-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
                >
                    <IconX className="h-3.5 w-3.5" />
                </button>
            ) : null}
        </div>
    );
}
