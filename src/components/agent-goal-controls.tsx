'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { IconTarget } from '@tabler/icons-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

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

// Labels: goals.cadence.{value} in messages/*.json.
const CADENCE_OPTIONS = [15, 60, 240, 1440] as const;
const OBJECTIVE_STATUSES = new Set(['active', 'paused', 'blocked', 'completed', 'cancelled']);

export function AgentGoalControls({ agentId }: { agentId: string }) {
    const t = useTranslations('goals');
    const cadenceLabel = (minutes: number) => (CADENCE_OPTIONS.some((value) => value === minutes) ? t(`cadence.${minutes as 15}`) : t('cadenceEvery', { minutes }));
    const statusLabel = (current: Objective | null, isPending: boolean) => {
        if (isPending) return t('status.starting');
        if (!current || !OBJECTIVE_STATUSES.has(current.status)) return null;
        return t(`status.${current.status}`);
    };
    const [objective, setObjective] = useState<Objective | null>(null);
    const [restricted, setRestricted] = useState(false);
    const [pending, setPending] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [text, setText] = useState('');
    const [cadenceMinutes, setCadenceMinutes] = useState(60);
    const detailsRef = useRef<HTMLDetailsElement>(null);

    // Behave like a popover: close on outside click or Escape.
    useEffect(() => {
        function close(event: Event) {
            const details = detailsRef.current;
            if (!details?.open) return;
            if (event instanceof KeyboardEvent) {
                if (event.key !== 'Escape') return;
                details.open = false;
                details.querySelector('summary')?.focus();
            } else if (!details.contains(event.target as Node)) {
                details.open = false;
            }
        }
        document.addEventListener('pointerdown', close);
        document.addEventListener('keydown', close);
        return () => {
            document.removeEventListener('pointerdown', close);
            document.removeEventListener('keydown', close);
        };
    }, []);

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
            if (!response.ok) throw new Error(result.error || t('updateFailed'));
            await load();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : t('updateFailed'));
        } finally {
            setBusy(false);
        }
    }

    async function startObjective() {
        if (busy || !text.trim()) return;
        await act({ action: 'start', objective: text, cadenceMinutes });
    }

    const live = objective && (objective.status === 'active' || objective.status === 'paused' || objective.status === 'blocked');
    const button = 'min-h-9 rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-40';
    return (
        <details ref={detailsRef} className="group">
            <summary
                title={t('summaryTitle')}
                className={cn(
                    'flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors [&::-webkit-details-marker]:hidden',
                    live || pending
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200 hover:border-emerald-500/50'
                        : 'border-transparent text-zinc-400 hover:border-zinc-700 hover:text-zinc-200',
                )}
            >
                <IconTarget className="h-3.5 w-3.5" />
                <span className="sr-only sm:not-sr-only">{statusLabel(objective, pending) ? t('objectiveWithStatus', { status: statusLabel(objective, pending) ?? '' }) : t('objective')}</span>
            </summary>
            <div className="absolute inset-x-0 bottom-full z-30 mb-2 text-zinc-200">
            <div className="max-h-[60dvh] space-y-3 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950 p-3 shadow-2xl shadow-black/50 sm:max-h-96">
                {objective && (
                    <div className="space-y-1">
                        <p className="max-h-28 overflow-y-auto break-words text-sm">{restricted ? (objective.message ?? t('managedElsewhere')) : objective.objective}</p>
                        <p className="text-xs text-zinc-400">{t('checkIns', { cadence: cadenceLabel(objective.cadenceMinutes), done: objective.followupCount, max: objective.maxFollowups })}</p>
                        {objective.status === 'blocked' && objective.blockerReason && <p className="text-xs text-rose-300">{t('blocked', { reason: objective.blockerReason })}</p>}
                        {objective.completionSummary && <p className="text-xs text-emerald-300">{t('result', { summary: objective.completionSummary })}</p>}
                    </div>
                )}
                {restricted ? null : live ? (
                    <div className="flex flex-wrap gap-2">
                        {objective.status === 'active' && <button type="button" className={button} disabled={busy} onClick={() => void act({ action: 'pause' })}>{t('pause')}</button>}
                        {objective.status !== 'active' && <button type="button" className={button} disabled={busy} onClick={() => void act({ action: 'resume' })}>{t('resume')}</button>}
                        <button type="button" className={button} disabled={busy} onClick={() => void act({ action: 'stop' })}>{t('stop')}</button>
                    </div>
                ) : (
                    <div className="space-y-3">
                        <label className="block text-xs text-zinc-400">{t('whatToFinish')}
                            <textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={4000} rows={3} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void startObjective(); } }} className="mt-1 w-full resize-y rounded-lg border border-zinc-700 bg-zinc-900 p-2.5 text-base text-zinc-100 sm:text-sm" placeholder={t('placeholder')} />
                        </label>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <label className="flex items-center gap-2 text-xs text-zinc-400">{t('cadenceLabel')}
                                <select aria-label={t('cadenceLabel')} value={cadenceMinutes} onChange={(event) => setCadenceMinutes(Number(event.target.value))} className="min-h-9 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100">
                                    {CADENCE_OPTIONS.map((value) => <option key={value} value={value}>{t(`cadence.${value}`)}</option>)}
                                </select>
                            </label>
                            <button type="button" onClick={() => void startObjective()} disabled={busy || !text.trim()} className={button}>{busy ? t('starting') : t('start')}</button>
                        </div>
                        <p className="text-xs leading-relaxed text-zinc-500">{t('stopHint')}</p>
                    </div>
                )}
                {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
            </div>
            </div>
        </details>
    );
}
