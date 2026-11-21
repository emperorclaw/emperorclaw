import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { OtherSurface, type SurfaceData } from './surfaces';
import en from '../../../messages/en.json';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { StreamingMarkdown } from '@/components/chat/streaming-markdown';
import { RichMessageActionsContext } from '@/components/rich/rich-message-actions';
import { MessageReasoningDisclosure } from '@/components/message-reasoning-disclosure';
import { LiveRunSteps, ReplyRunFooter, type ReplyRun } from '@/components/run-timeline';
import { mergeLiveRuns, lastReasoningLine, type ClientLiveRun } from '@/lib/live-activity';
import { withResponsePreviews, chatRowKey } from '@/lib/chat/use-chat-responses';
import type { ChatPreview } from '@/lib/chat/response-contract';
import type { RunLive } from '@/lib/run-events';

type File = { id: string; name: string };
type Message = { id: string; text: string; senderType: string; senderName?: string; senderId?: string; createdAt: string; clientMessageId?: string; metadataJson?: { attachments?: File[]; hasReasoning?: boolean }; preview?: ChatPreview };
type Participant = { participantType: string; participantId: string; typingUntil?: string; currentActivity?: string };
type Payload = SurfaceData & { participants: Participant[]; agentNames: Record<string, string>; messages: Message[]; previews: ChatPreview[]; liveRuns: RunLive[]; replyRuns: Record<string, ReplyRun>; hasMore: boolean; loaded: boolean; streaming: boolean; title: string; locale: string; mayWrite: boolean; forceBottom: number; dark: boolean; loadingOlder: boolean };
type NativeRequest = { type: string; [key: string]: unknown };
declare global { interface Window { webkit?: { messageHandlers: { chat: { postMessage: (message: NativeRequest) => void } } }; emperor: { update: (payload: Payload) => void; resolve: (id: string, value: unknown, error?: string) => void } } }
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
function post(message: NativeRequest) { window.webkit?.messageHandlers.chat.postMessage(message); }
function request(type: string, fields: Record<string, unknown>): Promise<unknown> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Request timed out')); }, 30_000);
        pending.set(id, { resolve, reject, timer }); post({ type, id, ...fields });
    });
}
// Components receive JSON through a narrow native bridge, never a bearer token,
// browser session, unrestricted network proxy, or arbitrary native operation.
window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if ((init?.method ?? 'GET') !== 'GET' || !/^\/api\/(ui\/entities\?|chat\/reasoning\?|runs\/[0-9a-f-]{36}\/events(?:\?|$))/i.test(url)) throw new Error('Unsupported transcript resource');
    try { return new Response(JSON.stringify(await request('resource', { url })), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
    catch { return new Response('{}', { status: 503 }); }
};
const empty: Payload = { participants: [], agentNames: {}, messages: [], previews: [], liveRuns: [], replyRuns: {}, hasMore: false, loaded: false, streaming: false, title: '', locale: 'en', mayWrite: false, forceBottom: 0, dark: true, loadingOlder: false };
function Transcript() {
    const [data, setData] = useState(empty);
    const [following, setFollowing] = useState(true);
    const [runs, setRuns] = useState<ClientLiveRun[]>([]);
    const scroll = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
    const follow = useRef(true), placed = useRef(false), lastForce = useRef(0), painted = useRef(false);
    const anchor = useRef<{ id: string; offset: number } | null>(null);
    const spanish = data.locale.startsWith('es');
    useEffect(() => {
        window.emperor = {
            update(payload) {
                const node = scroll.current;
                if (node && placed.current && !follow.current) {
                    const first = [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(row => row.getBoundingClientRect().bottom > node.getBoundingClientRect().top);
                    anchor.current = first ? { id: first.dataset.messageId!, offset: first.getBoundingClientRect().top - node.getBoundingClientRect().top } : null;
                }
                if (!placed.current || payload.forceBottom !== lastForce.current) { follow.current = true; setFollowing(true); }
                document.documentElement.classList.toggle('dark', payload.dark);
                document.documentElement.classList.toggle('embedded', payload.embedded === true);
                document.documentElement.classList.toggle('reduced-motion', payload.reducedMotion === true);
                document.documentElement.style.fontSize = `${16 * Math.max(0.8, Math.min(3.2, payload.textScale ?? 1))}px`;
                setRuns(previous => mergeLiveRuns(previous, payload.liveRuns, Date.now()));
                setData(payload);
            },
            resolve(id, value, error) {
                const item = pending.get(id); if (!item) return;
                clearTimeout(item.timer); pending.delete(id);
                if (error) item.reject(new Error(error)); else item.resolve(value);
            }
        };
        post({ type: 'ready' });
        const links = (event: MouseEvent) => {
            const link = (event.target as Element).closest('a'); if (!link) return;
            event.preventDefault(); post({ type: 'link', url: link.getAttribute('href') });
        };
        const selection = () => { const selected = window.getSelection(); if (selected && !selected.isCollapsed && scroll.current?.contains(selected.anchorNode)) { follow.current = false; setFollowing(false); } };
        document.addEventListener('click', links); document.addEventListener('selectionchange', selection);
        return () => { document.removeEventListener('click', links); document.removeEventListener('selectionchange', selection); };
    }, []);
    useLayoutEffect(() => {
        const node = scroll.current; if (!node || !data.loaded) return;
        if (!placed.current || data.forceBottom !== lastForce.current) {
            placed.current = true; follow.current = true;
        }
        lastForce.current = data.forceBottom;
        if (follow.current) node.scrollTop = node.scrollHeight;
        else if (anchor.current) {
            const row = [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(row => row.dataset.messageId === anchor.current!.id);
            if (row) node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.current.offset;
        }
        anchor.current = null;
        // Native shows its own placeholder until the first loaded transcript is on screen.
        if (!painted.current) { painted.current = true; requestAnimationFrame(() => post({ type: 'painted' })); }
    }, [data]);
    useEffect(() => {
        const resize = new ResizeObserver(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; });
        if (content.current) resize.observe(content.current);
        if (scroll.current) resize.observe(scroll.current);
        return () => resize.disconnect();
    }, []);
    const rows = withResponsePreviews(data.messages, data.previews, preview => ({ id: preview.responseId, text: preview.text, senderType: 'agent', senderName: preview.agentName, createdAt: preview.updatedAt, preview }));
    return <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
        {data.mode && data.mode !== 'chat' ? <OtherSurface data={data} post={post} /> : <><div id="transcript" ref={scroll} role="log" aria-label={spanish ? 'Conversación' : 'Conversation'} aria-live="off"
            onTouchMove={() => { follow.current = false; setFollowing(false); }}
            onWheel={event => { if (event.deltaY < 0) { follow.current = false; setFollowing(false); } }}
            onScroll={() => { const node = scroll.current!; const near = node.scrollHeight - node.scrollTop - node.clientHeight < 60; follow.current = near; setFollowing(near); }}>
            <div ref={content}>
                {!data.loaded && <p role="status">{spanish ? 'Cargando conversación…' : 'Loading conversation…'}</p>}
                {data.hasMore && <button type="button" disabled={data.loadingOlder} onClick={() => post({ type: 'older' })}>{data.loadingOlder ? (spanish ? 'Cargando…' : 'Loading…') : (spanish ? 'Cargar mensajes anteriores' : 'Load earlier messages')}</button>}
                {rows.map((message, index) => {
                    const human = message.senderType === 'human', preview = message.preview;
                    const key = chatRowKey(message, data.previews);
                    return <article key={key} data-message-id={key} className={`chat-message ${human ? 'human' : 'agent'}`}>
                        <header>{human ? (spanish ? 'Tú' : 'You') : message.senderName || data.agentNames[message.senderId ?? ""] || data.title}</header>
                        <RichMessageActionsContext.Provider value={{ sendPrompt: data.mayWrite && !preview ? async prompt => { try { return await request('sendPrompt', { prompt }) === true; } catch { return false; } } : undefined, laterReplies: rows.slice(index + 1).filter(row => row.senderType === 'human').map(row => row.text) }}>
                            <div className="body">{preview ? <StreamingMarkdown text={message.text} /> : <MarkdownRenderer content={message.text} density="compact" />}
                                {message.metadataJson?.attachments?.map(file => <button className="attachment" key={file.id} type="button" onClick={() => post({ type: 'attachment', file })}>{file.name || (spanish ? 'Abrir archivo' : 'Open attachment')}</button>)}
                                {preview && <p className="text-xs text-zinc-500" role="status">{preview.state === 'streaming' ? (spanish ? 'Respondiendo…' : 'Responding…') : preview.state === 'capped' ? (spanish ? 'Límite de vista previa alcanzado; esperando la respuesta final…' : 'Preview limit reached; waiting for the saved reply…') : preview.state === 'failed' || preview.state === 'interrupted' ? (spanish ? 'Respuesta interrumpida' : 'Response interrupted') : (spanish ? 'Guardando respuesta…' : 'Saving reply…')}</p>}
                                {!human && !preview && message.metadataJson?.hasReasoning && <MessageReasoningDisclosure messageId={message.id} />}
                                {!human && !preview && data.replyRuns[message.id] && <ReplyRunFooter run={data.replyRuns[message.id]} />}
                                {human && <p className="text-xs text-zinc-500">{spanish ? 'Recibido por el servidor' : 'Received by server'}</p>}
                            </div>
                        </RichMessageActionsContext.Provider>
                    </article>;
                })}
                <Activity runs={runs} data={data} spanish={spanish} empty={data.loaded && rows.length === 0} />
            </div>
        </div>
        {!following && <button id="latest" onClick={() => { follow.current = true; setFollowing(true); if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }}>{spanish ? 'Último mensaje ↓' : 'Latest message ↓'}</button>}
        </>}
    </NextIntlClientProvider>;
}
function Activity({ runs, data, spanish, empty }: { runs: ClientLiveRun[]; data: Payload; spanish: boolean; empty: boolean }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
    const active = runs.filter(run => run.status === 'running');
    const covered = new Set(active.map(run => run.agentId));
    const typing = data.participants.filter(participant => participant.participantType === 'agent' && !covered.has(participant.participantId) && participant.typingUntil && new Date(participant.typingUntil).getTime() > now);
    return <>
        {empty && active.length === 0 && typing.length === 0 && <div className="chat-empty">
            <p className="chat-empty-title">{spanish ? `Empieza una conversación con ${data.title}` : `Start a conversation with ${data.title}`}</p>
            <p>{spanish ? 'Tus mensajes y el trabajo del agente aparecerán aquí.' : 'Your messages and the agent’s work will appear here.'}</p>
        </div>}
        {active.map(run => <section className="activity" key={run.runId} aria-label={spanish ? 'Actividad del agente' : 'Agent activity'}>
            <p role="status">{data.agentNames[run.agentId ?? ''] || data.title}: {run.current.summary || (spanish ? 'Trabajando…' : 'Working…')}</p>
            {lastReasoningLine(run) && <p className="mt-1 text-zinc-400">{lastReasoningLine(run)}</p>}
            <LiveRunSteps steps={run.steps} usage={run.usage} />
        </section>)}
        {typing.map(participant => <section className="activity" key={participant.participantId}><p role="status">{data.agentNames[participant.participantId] || data.title}: {participant.currentActivity || (spanish ? 'Trabajando…' : 'Working…')}</p></section>)}
    </>;
}
createRoot(document.getElementById('root')!).render(<Transcript />);
