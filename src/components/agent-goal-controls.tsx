'use client';
import { useCallback, useEffect, useState } from 'react';

type Objective = {
    id: string;
    objective: string | null;
    status: 'active' | 'paused' | 'blocked' | 'completed' | 'cancelled';
    cadenceMinutes: number;
    maxFollowups: number;
    followupCount: number;
    blockerReason: string | null;
    completionSummary: string | null;
    lastPromptAt: string | null;
    nextRunAt: string | null;
    restricted?: boolean;
    message?: string;
};

const CADENCE_OPTIONS = [
    { value: 15, label: 'Every 15 minutes' },
    { value: 60, label: 'Every hour' },
    { value: 240, label: 'Every 4 hours' },
    { value: 1440, label: 'Once a day' },
];

function cadenceLabel(minutes: number) {
    return CADENCE_OPTIONS.find((option) => option.value === minutes)?.label ?? `Every ${minutes} min`;
}

function statusLabel(objective: Objective | null, pending: boolean) {
    if (pending) return ' · starting';
    if (!objective) return '';
    switch (objective.status) {
        case 'active': return ' · working';
        case 'paused': return ' · paused';
        case 'blocked': return ' · blocked';
        case 'completed': return ' · completed';
        case 'cancelled': return ' · stopped';
        default: return '';
    }
}

export function AgentGoalControls({ agentId }: { agentId: string }) {
    const [objective, setObjective] = useState<Objective | null>(null);
    const [restricted, setRestricted] = useState(false);
    const [pending, setPending] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [text, setText] = useState('');
    const [cadenceMinutes, setCadenceMinutes] = useState(60);

    const load = useCallback(async () => {
        try {
            const response = await fetch(`/api/agents/${agentId}/goal`);
            if (!response.ok) return;
            const result = await response.json();
            setObjective(result.objective ?? null);
            setRestricted(Boolean(result.restricted));
            setPending(Boolean(result.pending));
        } catch { /* The conversation remains usable during a temporary disconnect. */ }
    }, [agentId]);

    useEffect(() => {
        void load();
        const timer = setInterval(() => void load(), 5000);
        return () => clearInterval(timer);
    }, [load]);

    async function act(body: Record<string, unknown>) {
        setBusy(true);
        setError(null);
        try {
            const response = await fetch(`/api/agents/${agentId}/goal`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Could not update objective');
            await load();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not update objective');
        } finally {
            setBusy(false);
        }
    }

    const live = objective && (objective.status === 'active' || objective.status === 'paused' || objective.status === 'blocked');
    const button = 'min-h-11 rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-40';
    return (
        <details className="mx-2 my-2 rounded-xl border border-zinc-800 bg-zinc-950/50 text-zinc-200 sm:mx-4">
            <summary className="min-h-11 cursor-pointer px-3 py-3 text-sm font-medium">Objective{statusLabel(objective, pending)}</summary>
            <div className="max-h-[45dvh] space-y-3 overflow-y-auto border-t border-zinc-800 p-3 sm:max-h-80">
                {objective && (
                    <div className="space-y-1">
                        <p className="max-h-28 overflow-y-auto break-words text-sm">{restricted ? (objective.message ?? 'Managed in another private conversation.') : objective.objective}</p>
                        <p className="text-xs text-zinc-400">{cadenceLabel(objective.cadenceMinutes)} · {objective.followupCount}/{objective.maxFollowups} check-ins</p>
                        {objective.status === 'blocked' && objective.blockerReason && <p className="text-xs text-rose-300">Blocked: {objective.blockerReason}</p>}
                        {objective.completionSummary && <p className="text-xs text-emerald-300">Result: {objective.completionSummary}</p>}
                    </div>
                )}
                {restricted ? null : live ? (
                    <div className="flex flex-wrap gap-2">
                        {objective.status === 'active' && <button type="button" className={button} disabled={busy} onClick={() => void act({ action: 'pause' })}>Pause</button>}
                        {objective.status !== 'active' && <button type="button" className={button} disabled={busy} onClick={() => void act({ action: 'resume' })}>Resume</button>}
                        <button type="button" className={button} disabled={busy} onClick={() => void act({ action: 'stop' })}>Stop</button>
                    </div>
                ) : (
                    <form onSubmit={(event) => { event.preventDefault(); void act({ action: 'start', objective: text, cadenceMinutes }); }} className="space-y-3">
                        <label className="block text-xs text-zinc-400">What should the agent finish?
                            <textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={4000} rows={3} required className="mt-1 w-full resize-y rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-base text-zinc-100" placeholder={'Describe the outcome and how to verify it.'} />
                        </label>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <label className="flex items-center gap-2 text-xs text-zinc-400">Check-in cadence
                                <select aria-label="Check-in cadence" value={cadenceMinutes} onChange={(event) => setCadenceMinutes(Number(event.target.value))} className="min-h-11 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100">
                                    {CADENCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                                </select>
                            </label>
                            <button type="submit" disabled={busy || !text.trim()} className={button}>{busy ? 'Starting…' : 'Start objective'}</button>
                        </div>
                        <p className="text-xs leading-relaxed text-zinc-500">Emperor sends the agent a private check-in on this cadence and stops automatically when the objective completes, blocks, stops, or reaches its check-in budget. Works with every runtime.</p>
                    </form>
                )}
                {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
            </div>
        </details>
    );
}
