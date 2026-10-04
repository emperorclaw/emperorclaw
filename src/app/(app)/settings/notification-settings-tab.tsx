"use client";

import { useEffect, useState } from "react";
import { IconBell, IconBrandDiscord, IconBrandSlack, IconCheck, IconMail, IconWebhook } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

type Kind = { kind: string; label: string };
type Webhook = { urlHint: string; format: string; kinds: string[]; enabled: boolean; lastDeliveryAt: string | null; lastError: string | null };

const WEBHOOK_LABELS: Record<string, string> = {
    mention: "Mentions",
    decision: "Decisions",
    approval: "Approvals",
    task_assigned: "Assigned tasks",
    agent_failed: "Agent failures",
    agent_down: "Agents down",
    incident: "Serious incidents",
};

function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40", checked ? "bg-cyan-400" : "bg-zinc-700")}
        >
            <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all", checked ? "left-[18px]" : "left-0.5")} />
        </button>
    );
}

/**
 * Notifications: your email choices, plus (for admins) the company webhook.
 * Everything always reaches the in-app inbox (the bell in the sidebar).
 */
export function NotificationSettingsTab({ isAdmin }: { isAdmin: boolean }) {
    const [kinds, setKinds] = useState<Kind[]>([]);
    const [emailKinds, setEmailKinds] = useState<string[]>([]);
    const [emailConfigured, setEmailConfigured] = useState(true);
    const [savedPrefs, setSavedPrefs] = useState(false);

    const [hook, setHook] = useState<Webhook | null>(null);
    const [hookKinds, setHookKinds] = useState<string[]>(["decision", "approval", "agent_failed", "incident"]);
    const [allKinds, setAllKinds] = useState<string[]>([]);
    const [canStoreSecrets, setCanStoreSecrets] = useState(true);
    const [url, setUrl] = useState("");
    const [hookMessage, setHookMessage] = useState<{ ok: boolean; text: string } | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        void (async () => {
            const res = await fetch("/api/notifications/preferences");
            if (res.ok) {
                const data = await res.json();
                setKinds(data.kinds);
                setEmailKinds(data.emailKinds);
                setEmailConfigured(data.emailConfigured);
            }
            if (isAdmin) {
                const hookRes = await fetch("/api/notifications/webhook");
                if (hookRes.ok) {
                    const data = await hookRes.json();
                    setCanStoreSecrets(data.canStoreSecrets);
                    setAllKinds(data.kinds);
                    if (data.webhook) {
                        setHook(data.webhook);
                        setHookKinds(data.webhook.kinds);
                    }
                }
            }
        })();
    }, [isAdmin]);

    const savePrefs = async (next: string[]) => {
        setEmailKinds(next);
        const res = await fetch("/api/notifications/preferences", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ emailKinds: next }) });
        if (res.ok) {
            setSavedPrefs(true);
            setTimeout(() => setSavedPrefs(false), 1500);
        }
    };

    const saveHook = async (patch: Record<string, unknown>) => {
        setBusy(true);
        setHookMessage(null);
        try {
            const res = await fetch("/api/notifications/webhook", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "Could not save the webhook");
            setHook((prev) => ({ ...(prev ?? { lastDeliveryAt: null, lastError: null }), ...data.webhook }));
            setUrl("");
            setHookMessage({ ok: true, text: "Saved." });
        } catch (e) {
            setHookMessage({ ok: false, text: e instanceof Error ? e.message : "Could not save the webhook" });
        } finally {
            setBusy(false);
        }
    };

    const testHook = async () => {
        setBusy(true);
        setHookMessage(null);
        const res = await fetch("/api/notifications/webhook/test", { method: "POST" });
        const data = await res.json().catch(() => ({}));
        setHookMessage(res.ok ? { ok: true, text: "Test sent — check your channel." } : { ok: false, text: data.error || "The channel didn't accept the test" });
        setHook((prev) => prev && (res.ok
            ? { ...prev, lastDeliveryAt: new Date().toISOString(), lastError: null }
            : { ...prev, lastError: data.error || "Delivery failed" }));
        setBusy(false);
    };

    const removeHook = async () => {
        setBusy(true);
        await fetch("/api/notifications/webhook", { method: "DELETE" });
        setHook(null);
        setHookMessage(null);
        setBusy(false);
    };

    return (
        <section id="notifications" className="grid gap-4 lg:grid-cols-2">
            <article className="emperor-panel rounded-2xl p-4 sm:rounded-3xl sm:p-6">
                <div className="flex items-center gap-3">
                    <span className="grid h-9 w-9 place-items-center rounded-xl border border-cyan-400/25 bg-cyan-400/10 text-cyan-300"><IconMail className="h-4 w-4" /></span>
                    <div className="min-w-0 flex-1">
                        <h2 className="text-base font-semibold text-zinc-100">Email me when…</h2>
                        <p className="text-xs text-zinc-500">Everything also lands in the <IconBell className="inline h-3 w-3" /> inbox in the sidebar.</p>
                    </div>
                    {savedPrefs && <span className="inline-flex items-center gap-1 text-xs text-emerald-400"><IconCheck className="h-3.5 w-3.5" />Saved</span>}
                </div>
                {!emailConfigured && (
                    <p className="mt-4 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                        Email isn&apos;t configured on this server (SMTP_HOST, SMTP_USER, SMTP_FROM), so these only take effect once it is. The in-app inbox works regardless.
                    </p>
                )}
                <ul className="mt-4 divide-y divide-zinc-800/80">
                    {kinds.map(({ kind, label }) => (
                        <li key={kind} className="flex items-center justify-between gap-3 py-2.5">
                            <span className="text-sm text-zinc-300">{label}</span>
                            <Toggle
                                label={label}
                                checked={emailKinds.includes(kind)}
                                onChange={(on) => void savePrefs(on ? [...emailKinds, kind] : emailKinds.filter((k) => k !== kind))}
                            />
                        </li>
                    ))}
                </ul>
            </article>

            {isAdmin && (
                <article className="emperor-panel rounded-2xl p-4 sm:rounded-3xl sm:p-6">
                    <div className="flex items-center gap-3">
                        <span className="grid h-9 w-9 place-items-center rounded-xl border border-cyan-400/25 bg-cyan-400/10 text-cyan-300"><IconWebhook className="h-4 w-4" /></span>
                        <div className="min-w-0 flex-1">
                            <h2 className="text-base font-semibold text-zinc-100">Team channel webhook</h2>
                            <p className="text-xs text-zinc-500">Post notifications to Slack, Discord, or any URL that accepts JSON.</p>
                        </div>
                    </div>

                    {!canStoreSecrets && (
                        <p className="mt-4 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                            Set EMPEROR_CLAW_MASTER_KEY on the server to add a webhook. Its URL is a credential and is stored encrypted.
                        </p>
                    )}

                    {hook ? (
                        <div className="mt-4 flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2.5">
                            {hook.format === "slack" ? <IconBrandSlack className="h-4 w-4 text-zinc-400" /> : hook.format === "discord" ? <IconBrandDiscord className="h-4 w-4 text-zinc-400" /> : <IconWebhook className="h-4 w-4 text-zinc-400" />}
                            <div className="min-w-0 flex-1">
                                <div className="truncate font-mono text-xs text-zinc-300">{hook.urlHint}</div>
                                <div className={cn("text-[11px]", hook.lastError ? "text-rose-300" : "text-zinc-500")}>
                                    {hook.lastError ? `Last delivery failed: ${hook.lastError}` : hook.lastDeliveryAt ? `Last delivered ${new Date(hook.lastDeliveryAt).toLocaleString()}` : "No deliveries yet"}
                                </div>
                            </div>
                            <Toggle label="Webhook enabled" checked={hook.enabled} onChange={(on) => void saveHook({ enabled: on })} disabled={busy} />
                        </div>
                    ) : null}

                    <div className="mt-4 flex gap-2">
                        <input
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            placeholder={hook ? "Replace with a new webhook URL" : "https://hooks.slack.com/services/…"}
                            aria-label="Webhook URL"
                            disabled={!canStoreSecrets}
                            className="h-10 min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-400/60 disabled:opacity-50"
                        />
                        <button
                            type="button"
                            onClick={() => void saveHook({ url, kinds: hookKinds })}
                            disabled={busy || !url.trim() || !canStoreSecrets}
                            className="rounded-lg bg-cyan-400 px-3 text-sm font-semibold text-cyan-950 hover:bg-cyan-300 disabled:opacity-50"
                        >
                            Save
                        </button>
                    </div>

                    <div className="mt-4">
                        <div className="mb-2 text-xs font-medium text-zinc-400">Send to the channel</div>
                        <div className="flex flex-wrap gap-1.5">
                            {allKinds.map((kind) => {
                                const on = hookKinds.includes(kind);
                                return (
                                    <button
                                        key={kind}
                                        type="button"
                                        aria-pressed={on}
                                        onClick={() => {
                                            const next = on ? hookKinds.filter((k) => k !== kind) : [...hookKinds, kind];
                                            setHookKinds(next);
                                            if (hook) void saveHook({ kinds: next });
                                        }}
                                        className={cn("rounded-full border px-2.5 py-1 text-xs transition-colors", on ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-100" : "border-zinc-700 text-zinc-500 hover:text-zinc-300")}
                                    >
                                        {WEBHOOK_LABELS[kind] ?? kind}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {hook && (
                        <div className="mt-4 flex gap-2">
                            <button type="button" onClick={() => void testHook()} disabled={busy} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-cyan-400/40 hover:text-cyan-100 disabled:opacity-50">Send test</button>
                            <button type="button" onClick={() => void removeHook()} disabled={busy} className="rounded-lg px-3 py-1.5 text-xs text-zinc-500 hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-50">Remove</button>
                        </div>
                    )}
                    {hookMessage && <p role="status" className={cn("mt-3 text-xs", hookMessage.ok ? "text-emerald-400" : "text-rose-300")}>{hookMessage.text}</p>}
                </article>
            )}
        </section>
    );
}
