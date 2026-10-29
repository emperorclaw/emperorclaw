"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { hostConnectCommand, originNeedsInsecure } from "@/lib/runtime-hosts/connect-command";
import { LATEST_HERMES_BRIDGE_VERSION } from "@/lib/hermes-bridge-version";

type Pairing = { code: string; expiresAt: string };

function remaining(expiresAt: string, now: number): number {
    return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
}

/**
 * Connect a host: a one-time code (10 minutes) and the command to paste on
 * the machine. The command downloads emperor-hermes for the current bridge
 * version, checks its sha256 and runs `emperor-hermes host connect`.
 */
export function ConnectHostDialog({ open, onOpenChange, onConnected }: { open: boolean; onOpenChange: (open: boolean) => void; onConnected?: () => void }) {
    const t = useTranslations("runtimeHosts.connect");
    const tc = useTranslations("common");
    const [pairing, setPairing] = useState<Pairing | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const [copied, setCopied] = useState(false);
    const [connected, setConnected] = useState<string | null>(null);
    const openedAt = useRef(0);

    const newCode = async () => {
        setLoading(true);
        setError(null);
        setCopied(false);
        try {
            const res = await fetch("/api/runtime-hosts", { method: "POST" });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || t("createFailed"));
            setPairing({ code: data.code, expiresAt: data.expiresAt });
            setNow(Date.now());
        } catch (err) {
            setError(err instanceof Error ? err.message : t("createFailed"));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (!open) {
            setPairing(null);
            setConnected(null);
            return;
        }
        openedAt.current = Date.now();
        void newCode();
    }, [open]);

    const secondsLeft = pairing ? remaining(pairing.expiresAt, now) : 0;
    const expiredNow = secondsLeft === 0;
    useEffect(() => {
        if (!open || !pairing || connected) return;
        const tick = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(tick);
    }, [open, pairing, connected]);

    // Notice the new host as soon as it pairs (the list is admin-only, like this dialog).
    useEffect(() => {
        if (!open || !pairing || connected || expiredNow) return;
        const poll = setInterval(async () => {
            try {
                const res = await fetch("/api/runtime-hosts", { cache: "no-store" });
                if (!res.ok) return;
                const data = await res.json() as { hosts: { name: string; createdAt: string; revokedAt: string | null }[] };
                const fresh = data.hosts.find((h) => !h.revokedAt && new Date(h.createdAt).getTime() >= openedAt.current - 5_000);
                if (fresh) {
                    setConnected(fresh.name);
                    onConnected?.();
                }
            } catch {
                // Keep polling.
            }
        }, 3000);
        return () => clearInterval(poll);
    }, [open, pairing, connected, expiredNow, onConnected]);

    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const command = pairing ? hostConnectCommand(origin, pairing.code) : "";
    const expired = Boolean(pairing) && secondsLeft === 0;

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            setError(t("copyFailed"));
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{t("title")}</DialogTitle>
                    <DialogDescription>
                        {t("description", { version: LATEST_HERMES_BRIDGE_VERSION })}
                    </DialogDescription>
                </DialogHeader>
                {connected ? (
                    <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-foreground">
                        <p className="flex items-center gap-2 font-medium"><IconCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />{t("connected", { name: connected })}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{t("connectedHint")}</p>
                    </div>
                ) : (
                    <div className="grid min-w-0 gap-3">
                        {pairing && (
                            <div className="flex flex-wrap items-baseline gap-3">
                                <span className="font-mono text-2xl font-semibold tracking-[0.2em] text-foreground" aria-label={t("pairingCode", { code: pairing.code.split("").join(" ") })}>{pairing.code}</span>
                                <span className={expired ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                                    {expired ? t("expired") : t("validFor", { time: `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}` })}
                                </span>
                            </div>
                        )}
                        {pairing && !expired && (
                            <div className="relative min-w-0">
                                <pre className="max-h-48 min-w-0 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-border bg-muted/40 p-3 pr-12 font-mono text-xs leading-5 text-foreground">{command}</pre>
                                <Button type="button" variant="outline" size="icon-sm" onClick={() => void copy()} className="absolute right-2 top-2" aria-label={t("copyCommand")}>
                                    {copied ? <IconCheck className="h-4 w-4" /> : <IconCopy className="h-4 w-4" />}
                                </Button>
                            </div>
                        )}
                        {loading && !pairing && <div className="h-24 animate-pulse rounded-xl bg-muted/40" />}
                        {originNeedsInsecure(origin) && (
                            <p role="alert" className="text-xs text-destructive">
                                {t("insecureWarning")}
                            </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                            {t("oneTimeHint")}
                        </p>
                        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
                    </div>
                )}
                <DialogFooter>
                    {!connected && (expired || error) && <Button type="button" variant="outline" onClick={() => void newCode()} disabled={loading}>{t("newCode")}</Button>}
                    <Button type="button" onClick={() => onOpenChange(false)}>{connected ? t("done") : tc("close")}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
