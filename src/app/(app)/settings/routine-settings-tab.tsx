"use client";

import { useEffect, useMemo, useState } from "react";
import { IconCheck, IconSend, IconSunrise } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

type Routine = { enabled: boolean; time: string; timezone: string; weekdaysOnly: boolean };

function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
    return (
        <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
            className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40", checked ? "bg-cyan-400" : "bg-zinc-700")}>
            <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all", checked ? "left-[18px]" : "left-0.5")} />
        </button>
    );
}

/**
 * The daily agent review: when it runs, in which timezone, and on which days.
 * Everyone can see it; admins change it.
 */
export function RoutineSettingsTab({ isAdmin }: { isAdmin: boolean }) {
    const [routine, setRoutine] = useState<Routine | null>(null);
    const [configured, setConfigured] = useState(true);
    const [lastRunOn, setLastRunOn] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
    const [busy, setBusy] = useState(false);

    const timezones = useMemo(() => {
        try {
            return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? ["UTC"];
        } catch {
            return ["UTC"];
        }
    }, []);
    const browserZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);

    useEffect(() => {
        void (async () => {
            const res = await fetch("/api/settings/agent-routine");
            if (!res.ok) return;
            const data = await res.json();
            setRoutine(data.routine);
            setConfigured(data.configured);
            setLastRunOn(data.lastRunOn);
        })();
    }, []);

    const save = async (patch: Partial<Routine>) => {
        if (!routine) return;
        const next = { ...routine, ...patch };
        setRoutine(next);
        const res = await fetch("/api/settings/agent-routine", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
        if (res.ok) {
            setConfigured(true);
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
        }
    };

    const runNow = async () => {
        setBusy(true);
        setMessage(null);
        const res = await fetch("/api/settings/agent-routine", { method: "POST" });
        const data = await res.json().catch(() => ({}));
        setMessage(res.ok
            ? { ok: true, text: data.agentsReviewed ? `Sent to ${data.agentsReviewed} agent${data.agentsReviewed === 1 ? "" : "s"} with open tasks. Their summaries arrive in each agent's direct chat.` : "No agent has open tasks, so nothing was sent." }
            : { ok: false, text: data.error || "Couldn't send the review" });
        setBusy(false);
    };

    if (!routine) return <div className="emperor-panel h-40 animate-pulse rounded-3xl" />;
    const disabled = !isAdmin;

    return (
        <section className="grid gap-4 lg:grid-cols-2">
            <article className="emperor-panel rounded-2xl p-4 sm:rounded-3xl sm:p-6">
                <div className="flex items-center gap-3">
                    <span className="grid h-9 w-9 place-items-center rounded-xl border border-cyan-400/25 bg-cyan-400/10 text-cyan-300"><IconSunrise className="h-4 w-4" /></span>
                    <div className="min-w-0 flex-1">
                        <h2 className="text-base font-semibold text-zinc-100">Daily agent review</h2>
                        <p className="text-xs text-zinc-500">Each morning, every agent with open tasks reviews them and reports back.</p>
                    </div>
                    {saved && <span className="inline-flex items-center gap-1 text-xs text-emerald-400"><IconCheck className="h-3.5 w-3.5" />Saved</span>}
                    <Toggle label="Daily review" checked={routine.enabled} onChange={(on) => void save({ enabled: on })} disabled={disabled} />
                </div>

                <div className={cn("mt-5 grid gap-3 sm:grid-cols-2", !routine.enabled && "opacity-50")}>
                    <label className="block">
                        <span className="text-xs font-medium text-zinc-400">Time</span>
                        <input type="time" value={routine.time} disabled={disabled || !routine.enabled}
                            onChange={(e) => e.target.value && void save({ time: e.target.value })}
                            className="mt-1 h-10 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-cyan-400/60" />
                    </label>
                    <label className="block">
                        <span className="text-xs font-medium text-zinc-400">Timezone</span>
                        <select value={routine.timezone} disabled={disabled || !routine.enabled}
                            onChange={(e) => void save({ timezone: e.target.value })}
                            className="mt-1 h-10 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-cyan-400/60">
                            {[...new Set([routine.timezone, ...timezones])].map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                        </select>
                    </label>
                </div>
                {isAdmin && !configured && routine.timezone !== browserZone && (
                    <button type="button" onClick={() => void save({ timezone: browserZone })} className="mt-2 text-xs text-cyan-300 hover:text-cyan-200">
                        Use my timezone ({browserZone})
                    </button>
                )}
                <div className={cn("mt-4 flex items-center justify-between gap-3 border-t border-zinc-800/80 pt-4", !routine.enabled && "opacity-50")}>
                    <span className="text-sm text-zinc-300">Weekdays only</span>
                    <Toggle label="Weekdays only" checked={routine.weekdaysOnly} onChange={(on) => void save({ weekdaysOnly: on })} disabled={disabled || !routine.enabled} />
                </div>
                <p className="mt-4 text-xs text-zinc-500">
                    {lastRunOn ? `Last sent ${lastRunOn}. ` : ""}Agents without open tasks get nothing, so idle agents cost no tokens.
                    {!isAdmin && " Only admins can change this."}
                </p>
            </article>

            <article className="emperor-panel rounded-2xl p-4 sm:rounded-3xl sm:p-6">
                <h2 className="text-base font-semibold text-zinc-100">What each agent gets</h2>
                <p className="mt-1 text-xs text-zinc-500">A message in its direct chat, with live cards for its tasks:</p>
                <ul className="mt-3 space-y-1.5 text-sm text-zinc-300">
                    <li>• Its open tasks, overdue and soonest-due first</li>
                    <li>• Move each forward and keep its state current</li>
                    <li>• Note today&apos;s progress or the exact blocker</li>
                    <li>• Close only when the acceptance criteria are met; request approval where sign-off is needed</li>
                    <li>• Ask a person one concrete question for anything blocked</li>
                    <li>• Reply with a summary: done, in progress, blocked</li>
                </ul>
                {isAdmin && (
                    <button type="button" onClick={() => void runNow()} disabled={busy}
                        className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:border-cyan-400/40 hover:text-cyan-100 disabled:opacity-50">
                        <IconSend className="h-3.5 w-3.5" />Send today&apos;s review now
                    </button>
                )}
                {message && <p role="status" className={cn("mt-3 text-xs", message.ok ? "text-emerald-400" : "text-rose-300")}>{message.text}</p>}
            </article>
        </section>
    );
}
