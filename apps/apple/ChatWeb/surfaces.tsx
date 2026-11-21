import React, { type CSSProperties, useEffect, useRef, useState } from 'react';
import { CharacterFigureView, moodForStatus } from '@/components/character/character-avatar';
import { resolveAppearance } from '@/lib/character/model';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { ViewGrid, type ViewPanelView } from '@/components/views/view-panels';
import type { SceneStatus } from '@/lib/team-scene';
import type { CharacterExpression } from '@/lib/character/draw';

export type FleetAgent = { id: string; name: string; role: string; state: string; taskTitle?: string; activity?: string; avatarAppearance?: unknown; avatarUrl?: string; paused?: boolean };
export type SurfaceData = { mode?: 'chat' | 'fleet' | 'document' | 'view'; embedded?: boolean; text?: string; textScale?: number; reducedMotion?: boolean; fresh?: boolean; agents?: FleetAgent[]; view?: { title: string; description?: string; access: string; panels: ViewPanelView[]; createdAt: string; refreshEveryMinutes?: number } };
export function OtherSurface({ data, post }: { data: SurfaceData; post: (message: { type: string; [key: string]: unknown }) => void }) {
    const ref = useRef<HTMLDivElement>(null);
    const [awake, setAwake] = useState(true);
    useEffect(() => {
        const visible = () => setAwake(!document.hidden);
        document.addEventListener('visibilitychange', visible);
        return () => document.removeEventListener('visibilitychange', visible);
    }, []);
    useEffect(() => {
        if (!ref.current || !data.embedded) return;
        const node = ref.current;
        const resize = new ResizeObserver(() => post({ type: 'height', height: Math.ceil(node.scrollHeight) }));
        resize.observe(node);
        return () => resize.disconnect();
    }, [data.embedded, post]);
    return <div className={`surface-scroll ${data.embedded ? 'surface-embedded' : ''}`}><div ref={ref} className={`surface-body surface-${data.mode}`}>
        {data.mode === 'document' && <MarkdownRenderer content={data.text ?? ''} density="compact" />}
        {data.mode === 'view' && (data.view?.access === 'metadata' ? <div className="surface-private"><span aria-hidden>◈</span><h2>This view is private</h2><p>Its owner can share access with you. Panel values stay private.</p></div> : data.view && <>
            <div className="view-intro"><span className="surface-eyebrow">LIVE VIEW</span><h1>{data.view.title}</h1>{data.view.description && <MarkdownRenderer content={data.view.description} density="compact" allowWidgets={false} allowImages={false} />}</div>
            <ViewGrid panels={data.view.panels} refreshEveryMinutes={data.view.refreshEveryMinutes} since={data.view.createdAt} />
        </>)}
        {data.mode === 'fleet' && <div className={`fleet-floor ${data.reducedMotion || !awake || data.fresh === false ? 'fleet-still' : ''}`}>
            {data.agents?.map(agent => <Desk key={agent.id} agent={agent} fresh={data.fresh !== false} onSelect={() => post({ type: 'agent', agentId: agent.id })} />)}
        </div>}
    </div></div>;
}
function Desk({ agent, fresh, onSelect }: { agent: FleetAgent; fresh: boolean; onSelect: () => void }) {
    const status: SceneStatus = ['working', 'thinking', 'busy', 'typing'].includes(agent.state) ? 'working' : agent.state === 'blocked' || agent.state === 'waiting' || agent.state === 'offline' ? agent.state : 'idle';
    const appearance = resolveAppearance({ id: agent.id, avatarAppearance: agent.avatarAppearance, avatarUrl: agent.avatarUrl });
    const working = status === 'working' && !agent.paused && fresh;
    const expression: CharacterExpression = status === 'offline' ? 'sleepy' : status === 'blocked' ? 'worried' : working ? 'focused' : 'happy';
    const label = !fresh ? 'Last known status' : agent.paused ? 'Paused' : status === 'working' ? 'Working' : status === 'idle' ? 'Available' : status === 'blocked' ? 'Needs help' : status === 'offline' ? 'Offline' : 'Waiting';
    const line = agent.activity || agent.taskTitle || (status === 'offline' ? 'Not connected' : 'Ready');
    return <button className={`fleet-desk ${working ? 'is-working' : ''}`} style={{ '--agent-hue': appearance.hue } as CSSProperties} onClick={onSelect} aria-label={`${agent.name}, ${label}. ${line}. Open conversation`}>
        <div className="desk-status"><i data-status={status} /><span>{label}</span>{working && <span className="desk-dots" aria-hidden>•••</span>}</div>
        <div className="desk-stage" aria-hidden="true"><svg viewBox="-70 -108 140 135">
            <ellipse cy="12" rx="62" ry="12" fill={`hsl(${appearance.hue} 70% 55%)`} opacity=".12" />
            <g className="desk-figure"><CharacterFigureView appearance={appearance} mood={moodForStatus(status)} expression={expression} seated salt={`phone-${agent.id}`} /></g>
            <path d="M-53 -13 L53 -13 L62 0 L-62 0 Z" fill="var(--desk-top)" /><rect x="-62" y="0" width="124" height="12" rx="4" fill="var(--desk-front)" />
            <rect x="-42" y="-14" width="84" height="2" rx="1" fill={`hsl(${appearance.hue} 75% 55%)`} className="desk-terminal" />
            <path d="M-47 12v9m94-9v9" stroke="var(--desk-front)" strokeWidth="6" strokeLinecap="round" />
        </svg></div>
        <div className="desk-copy"><h2>{agent.name}</h2><p className="desk-work">{line}</p></div>
    </button>;
}
