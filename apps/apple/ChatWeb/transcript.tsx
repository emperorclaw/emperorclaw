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

type File = { id: string; name: string; contentType?: string; sizeBytes?: number };
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
    const follow = useRef(true), placed = useRef(false), lastForce = useRef(0), painted = useRef(false), loadedOnce = useRef(false);
    // Rows that arrive after the first loaded transcript animate in; history does not.
    const [settled, setSettled] = useState(false);
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
                if (loadedOnce.current) setSettled(true);
                if (payload.loaded) loadedOnce.current = true;
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
    // A preview with no text yet carries nothing to read: it never takes a place in the
    // history (its timestamp can sort it above newer replies). The single live row at the
    // bottom represents it instead.
    const rows = withResponsePreviews(data.messages, data.previews.filter(preview => preview.text.trim()), preview => ({ id: preview.responseId, text: preview.text, senderType: 'agent', senderName: preview.agentName, createdAt: preview.updatedAt, preview }));
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
                    const sender = human ? (spanish ? 'Tú' : 'You') : message.senderName || data.agentNames[message.senderId ?? ""] || data.title;
                    // "[no-reply]" means the agent had nothing to add: a quiet note, not a bubble.
                    if (!human && !preview && /^\s*\[no-reply\]\s*$/i.test(message.text)) {
                        return <Row key={key} id={key} animate={settled} className="chat-quiet">
                            <span className="sender-dot" style={{ background: senderColor(message.senderId || sender) }} aria-hidden="true" />
                            {sender} · {spanish ? 'sin nada que añadir' : 'nothing to add'}
                        </Row>;
                    }
                    return <Row key={key} id={key} animate={settled} className={`chat-message ${human ? 'human' : 'agent'}`}>
                        <header>{!human && <span className="sender-dot" style={{ background: senderColor(message.senderId || sender) }} aria-hidden="true" />}{sender}</header>
                        <RichMessageActionsContext.Provider value={{ sendPrompt: data.mayWrite && !preview ? async prompt => { try { return await request('sendPrompt', { prompt }) === true; } catch { return false; } } : undefined, laterReplies: rows.slice(index + 1).filter(row => row.senderType === 'human').map(row => row.text) }}>
                            <div className={`body ${preview && !message.text.trim() ? 'is-typing' : ''}`}><SmoothHeight>{preview ? (message.text.trim() ? <><StreamingMarkdown text={message.text} />{preview.state === 'streaming' && <span className="stream-caret" aria-hidden="true" />}</> : <TypingDots />) : <MarkdownRenderer content={message.text} density="compact" />}
                                {message.metadataJson?.attachments?.map(file => <AttachmentChip key={file.id} file={file} spanish={spanish} onOpen={() => post({ type: 'attachment', file })} />)}
                                {preview && (preview.state === 'streaming' || !['capped', 'failed', 'interrupted'].includes(preview.state)
                                    ? <p className="sr-only" role="status">{preview.state === 'streaming' ? (spanish ? 'Respondiendo…' : 'Responding…') : (spanish ? 'Guardando respuesta…' : 'Saving reply…')}</p>
                                    : <p className="preview-note" role="status">{preview.state === 'capped' ? (spanish ? 'Límite de vista previa alcanzado; esperando la respuesta final…' : 'Preview limit reached; waiting for the saved reply…') : (spanish ? 'Respuesta interrumpida' : 'Response interrupted')}</p>)}
                                {!human && !preview && message.metadataJson?.hasReasoning && <MessageReasoningDisclosure messageId={message.id} />}
                                {!human && !preview && data.replyRuns[message.id] && <ReplyRunFooter run={data.replyRuns[message.id]} />}
                                {human && <p className="text-xs text-zinc-500">{spanish ? 'Recibido por el servidor' : 'Received by server'}</p>}
                            </SmoothHeight></div>
                        </RichMessageActionsContext.Provider>
                    </Row>;
                })}
                <Activity runs={runs} data={data} spanish={spanish} empty={data.loaded && rows.length === 0} animate={settled} />
            </div>
        </div>
        {!following && <button id="latest" onClick={() => { follow.current = true; setFollowing(true); if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }}>{spanish ? 'Último mensaje ↓' : 'Latest message ↓'}</button>}
        </>}
    </NextIntlClientProvider>;
}
function Activity({ runs, data, spanish, empty, animate }: { runs: ClientLiveRun[]; data: Payload; spanish: boolean; empty: boolean; animate: boolean }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
    const active = runs.filter(run => run.status === 'running');
    const covered = new Set(active.map(run => run.agentId));
    const typing = data.participants.filter(participant => participant.participantType === 'agent' && !covered.has(participant.participantId) && participant.typingUntil && new Date(participant.typingUntil).getTime() > now);
    // One live indicator, always last: work in progress wins; otherwise a reply that
    // has started but has no words yet shows typing dots.
    const pending = active.length === 0 && typing.length === 0
        ? data.previews.filter(preview => preview.state === 'streaming' && !preview.text.trim() && !preview.finalMessageId).slice(-1)
        : [];
    const live = [
        ...pending.map(preview => <Row key={`pending-${preview.responseId}`} animate={animate} className="chat-message agent">
            <header>{preview.agentName || data.agentNames[preview.agentId ?? ''] || data.title}</header>
            <div className="body is-typing"><TypingDots /><span className="sr-only" role="status">{spanish ? 'Respondiendo…' : 'Responding…'}</span></div>
        </Row>),
        ...active.map(run => <Row as="section" className="activity" key={run.runId} animate={animate} label={spanish ? 'Actividad del agente' : 'Agent activity'}>
            <p role="status" className="activity-line"><ThinkingGlyph /><span className="activity-name">{data.agentNames[run.agentId ?? ''] || data.title}</span> <span className="shimmer" key={run.current.summary}>{run.current.summary || (spanish ? 'Pensando…' : 'Thinking…')}</span></p>
            {lastReasoningLine(run) && <p className="mt-1 text-zinc-400">{lastReasoningLine(run)}</p>}
            <LiveRunSteps steps={run.steps} usage={run.usage} />
        </Row>),
        ...typing.map(participant => <Row as="section" className="activity" key={participant.participantId} animate={animate}><p role="status" className="activity-line"><ThinkingGlyph /><span className="activity-name">{data.agentNames[participant.participantId] || data.title}</span> <span className="shimmer" key={participant.currentActivity}>{participant.currentActivity || (spanish ? 'Pensando…' : 'Thinking…')}</span></p></Row>),
    ];
    return <>
        <LiveArea open={live.length > 0}>{live}</LiveArea>
        {empty && live.length === 0 && <div className="chat-empty">
            <p className="chat-empty-title">{spanish ? `Empieza una conversación con ${data.title}` : `Start a conversation with ${data.title}`}</p>
            <p>{spanish ? 'Tus mensajes y el trabajo del agente aparecerán aquí.' : 'Your messages and the agent’s work will appear here.'}</p>
        </div>}
    </>;
}

/** A transcript row; rows that arrive after the transcript is placed rise in once. */
function Row({ id, animate, className, as = 'article', label, children }: { id?: string; animate: boolean; className: string; as?: 'article' | 'section'; label?: string; children: React.ReactNode }) {
    const [enter] = useState(animate); // decided at mount, so existing rows never re-animate
    const Tag = as;
    return <Tag data-message-id={id} aria-label={label} className={`${className}${enter ? ' row-enter' : ''}`}>{children}</Tag>;
}

/** Animates its own height to follow its content (streaming text, swaps). */
function SmoothHeight({ children }: { children: React.ReactNode }) {
    const inner = useRef<HTMLDivElement>(null);
    const [height, setHeight] = useState<number>();
    useLayoutEffect(() => {
        const node = inner.current; if (!node) return;
        const measure = () => setHeight(node.offsetHeight);
        const observer = new ResizeObserver(measure); observer.observe(node);
        return () => observer.disconnect();
    }, []);
    return <div className="smooth-height" style={{ height }}><div ref={inner} className="smooth-height-inner">{children}</div></div>;
}

/** Live work area: expands open, and on finish fades and collapses instead of vanishing. */
function LiveArea({ open, children }: { open: boolean; children: React.ReactNode }) {
    // The last live content is kept only so it can fade out while collapsing.
    const last = useRef<React.ReactNode>(null);
    const [mounted, setMounted] = useState(open);
    // Mount collapsed, then spring open on the next frame (otherwise it would appear at full height).
    const [expanded, setExpanded] = useState(false);
    // eslint-disable-next-line react-hooks/refs -- exit-animation snapshot, never drives what is current
    if (open) last.current = children;
    useEffect(() => {
        if (!open) { setExpanded(false); return; }
        const frame = requestAnimationFrame(() => requestAnimationFrame(() => setExpanded(true)));
        return () => cancelAnimationFrame(frame);
    }, [open]);
    useEffect(() => {
        if (open) { setMounted(true); return; }
        const timer = setTimeout(() => { setMounted(false); last.current = null; }, 1050);
        return () => clearTimeout(timer);
    }, [open]);
    if (!open && !mounted) return null;
    return <div className={`live-area ${open && expanded ? 'is-open' : 'is-closing'}`}><div className="live-area-inner">{/* eslint-disable-next-line react-hooks/refs -- exit-animation snapshot */}
        <SmoothHeight>{open ? children : last.current}</SmoothHeight></div></div>;
}
/** An attachment as a typed chip: photo, voice note or document. Opens natively (Quick Look). */
function AttachmentChip({ file, spanish, onOpen }: { file: File; spanish: boolean; onOpen: () => void }) {
    const type = (file.contentType ?? '').toLowerCase(), name = file.name || (spanish ? 'Archivo' : 'Attachment');
    const kind = type.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic)$/i.test(name) ? 'image' : type.startsWith('audio/') || /\.(m4a|mp3|wav|aac|ogg)$/i.test(name) ? 'audio' : 'doc';
    const voice = kind === 'audio' && /^voice note/i.test(name);
    const title = voice ? (spanish ? 'Nota de voz' : 'Voice note') : name;
    const length = voice ? name.match(/(\d+:\d{2})/)?.[1] : undefined;
    const size = file.sizeBytes ? file.sizeBytes < 1024 * 1024 ? `${Math.max(1, Math.round(file.sizeBytes / 1024))} KB` : `${(file.sizeBytes / 1024 / 1024).toFixed(1)} MB` : undefined;
    const detail = [length, kind === 'doc' ? name.split('.').pop()?.toUpperCase() : undefined, size].filter(Boolean).join(' · ');
    return <button className={`attachment attachment-${kind}`} type="button" onClick={onOpen} aria-label={`${title}${detail ? `, ${detail}` : ''}. ${spanish ? 'Abrir' : 'Open'}`}>
        <span className="attachment-icon" aria-hidden="true">{kind === 'image'
            ? <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="2" /><path d="M21 17l-5-5-9 8" /></svg>
            : kind === 'audio'
                ? <svg viewBox="0 0 24 24"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" /></svg>
                : <svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>}</span>
        <span className="attachment-text"><span className="attachment-title">{title}</span>{detail && <span className="attachment-detail">{detail}</span>}</span>
    </button>;
}
/** Same stable hue as the native avatars (FNV-1a 64-bit of the id, mod 360). */
function senderColor(id: string) {
    let hash = BigInt('1469598103934665603');
    const prime = BigInt('1099511628211'), mask = BigInt('0xFFFFFFFFFFFFFFFF');
    for (const byte of new TextEncoder().encode(id)) hash = ((hash ^ BigInt(byte)) * prime) & mask;
    return `hsl(${Number(hash % BigInt(360))} 62% 62%)`;
}
/** Three dots that bounce in sequence: the reply is on its way. */
function TypingDots() { return <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>; }
/** The brand sparkle that breathes and turns while an agent thinks or works. */
function ThinkingGlyph() {
    return <svg className="thinking-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5c.5 4.9 3.2 8.1 8.6 10.5-5.4 2.4-8.1 5.6-8.6 10.5-.5-4.9-3.2-8.1-8.6-10.5C8.8 9.6 11.5 6.4 12 1.5z" /></svg>;
}
createRoot(document.getElementById('root')!).render(<Transcript />);
