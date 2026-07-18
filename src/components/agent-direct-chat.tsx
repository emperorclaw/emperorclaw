"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Bot, Mic, Send, Square, Trash2, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "@/components/markdown-renderer";

const CHAT_PAGE_SIZE = 25;

type DirectThread = {
    id: string;
    type: string;
    title: string | null;
    createdAt: string;
};

type DirectMessage = {
    id: string;
    senderType: "human" | "agent" | "system";
    senderId?: string | null;
    fromUserId?: string | null;
    text: string;
    createdAt: string;
};

type DirectParticipant = {
    participantType: "human" | "agent" | "system" | string;
    typingUntil?: string | null;
    lastReadAt?: string | null;
};

// --- Grouping helpers ---

function isSameDay(a: string | Date, b: string | Date) {
    const da = new Date(a), db = new Date(b);
    return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

function isGroupContinuation(
    curr: { senderType: string; senderId?: string | null; fromUserId?: string | null; createdAt: string | Date },
    prev: typeof curr
) {
    if (curr.senderType !== prev.senderType) return false;
    const currId = curr.senderId ?? curr.fromUserId ?? null;
    const prevId = prev.senderId ?? prev.fromUserId ?? null;
    if (currId !== prevId) return false;
    return (new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime()) < 5 * 60 * 1000;
}

function dateSeparatorLabel(date: string | Date) {
    const d = new Date(date);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (isSameDay(d, today)) return "Today";
    if (isSameDay(d, yesterday)) return "Yesterday";
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function AgentDirectChat({
    agentId,
    agentName,
    hideHeader = false,
}: {
    agentId: string;
    agentName: string;
    hideHeader?: boolean;
}) {
    const [thread, setThread] = useState<DirectThread | null>(null);
    const [messages, setMessages] = useState<DirectMessage[]>([]);
    const [participants, setParticipants] = useState<DirectParticipant[]>([]);
    const [draft, setDraft] = useState("");
    const [isLoading, setIsLoading] = useState(true);
    const [isSending, setIsSending] = useState(false);
    const [isTyping, setIsTyping] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [hasOlderMessages, setHasOlderMessages] = useState(false);
    const [isLoadingOlder, setIsLoadingOlder] = useState(false);
    const [recordingSecs, setRecordingSecs] = useState(0);
    const audioBlobRef = useRef<Blob | null>(null);
    const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null);
    const [micError, setMicError] = useState<string | null>(null);
    const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const recordingChunksRef = useRef<Blob[]>([]);
    const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const lastSeenAtRef = useRef<string | null>(null);
    const preserveScrollHeightRef = useRef<number | null>(null);

    const rowVirtualizer = useVirtualizer({
        count: messages.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 88,
        overscan: 8,
        getItemKey: (index) => messages[index].id,
    });

    const loadMessages = useCallback(async ({ since, before }: { since?: string | null; before?: string | null } = {}) => {
        const params = new URLSearchParams({ targetAgentId: agentId });
        params.set("limit", String(CHAT_PAGE_SIZE));
        if (since) params.set("since", since);
        if (before) params.set("before", before);

        const res = await fetch(`/api/chat?${params.toString()}`);
        if (!res.ok) {
            throw new Error("Failed to load direct thread");
        }

        const data = await res.json() as {
            thread?: DirectThread;
            messages?: DirectMessage[];
            participants?: DirectParticipant[];
            hasMore?: boolean;
        };

        if (data.thread) {
            setThread(data.thread);
        }

        if (data.participants) {
            setParticipants(data.participants);
        }

        if (data.messages && data.messages.length > 0) {
            const nextMessages = data.messages;
            setMessages((prev) => {
                if (before) {
                    const existingIds = new Set(prev.map((message) => message.id));
                    const prepended = nextMessages.filter((message) => !existingIds.has(message.id));
                    return prepended.length > 0 ? [...prepended, ...prev] : prev;
                }
                if (!since) return nextMessages;
                const existingIds = new Set(prev.map((message) => message.id));
                const appended = nextMessages.filter((message) => !existingIds.has(message.id));
                return appended.length > 0 ? [...prev, ...appended] : prev;
            });

            if (!before) {
                lastSeenAtRef.current = nextMessages[nextMessages.length - 1].createdAt;
            }
        }

        const threadId = data.thread?.id;
        const shouldMarkRead = threadId && !before && (
            !since || data.messages?.some((message) => message.senderType === "agent")
        );
        if (shouldMarkRead) {
            void fetch("/api/chat/status", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ threadId, markRead: true }),
            });
        }

        if (!since) {
            setHasOlderMessages(Boolean(data.hasMore));
        }
    }, [agentId]);

    const loadOlderMessages = useCallback(async () => {
        if (isLoadingOlder || !hasOlderMessages || messages.length === 0) return;

        preserveScrollHeightRef.current = scrollRef.current?.scrollHeight ?? null;
        setIsLoadingOlder(true);
        try {
            await loadMessages({ before: messages[0].createdAt });
        } catch (error) {
            console.error("Failed to load older direct messages", error);
        } finally {
            setIsLoadingOlder(false);
        }
    }, [hasOlderMessages, isLoadingOlder, loadMessages, messages]);

    const handleTyping = (text: string) => {
        setDraft(text);

        if (!isTyping && text.trim().length > 0) {
            setIsTyping(true);
            if (thread?.id) {
                void fetch("/api/chat/status", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ threadId: thread.id, typing: true }),
                });
            }
        }

        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);

        typingTimeoutRef.current = setTimeout(() => {
            setIsTyping(false);
            if (thread?.id) {
                void fetch("/api/chat/status", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ threadId: thread.id, typing: false }),
                });
            }
        }, 3000);
    };

    useEffect(() => {
        let active = true;

        const initialize = async () => {
            setIsLoading(true);
            setMessages([]);
            setThread(null);
            setParticipants([]);
            lastSeenAtRef.current = null;

            try {
                await loadMessages();
            } catch (error) {
                if (active) {
                    console.error("Failed to initialize direct chat", error);
                }
            } finally {
                if (active) {
                    setIsLoading(false);
                }
            }
        };

        void initialize();

        const interval = setInterval(() => {
            void loadMessages({ since: lastSeenAtRef.current }).catch((error) => {
                if (active) {
                    console.error("Failed to poll direct chat", error);
                }
            });
        }, 5000);

        return () => {
            active = false;
            clearInterval(interval);
            if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        };
    }, [loadMessages]);

    useEffect(() => {
        if (scrollRef.current) {
            if (preserveScrollHeightRef.current !== null) {
                const previousHeight = preserveScrollHeightRef.current;
                preserveScrollHeightRef.current = null;
                scrollRef.current.scrollTop += scrollRef.current.scrollHeight - previousHeight;
                return;
            }
            if (messages.length > 0) {
                rowVirtualizer.scrollToIndex(messages.length - 1, { align: "end" });
            }
        }
    }, [messages, rowVirtualizer]);

    useEffect(() => {
        if (!navigator.permissions) return;
        navigator.permissions.query({ name: "microphone" as PermissionName }).then((result) => {
            if (result.state === "denied") {
                setMicError("blocked");
            }
            result.onchange = () => {
                if (result.state === "denied") setMicError("blocked");
                else if (result.state === "granted") setMicError(null);
            };
        }).catch(() => {/* permissions API not supported */});
    }, []);

    const startRecording = async () => {
        setMicError(null);

        // getUserMedia requires a secure context (HTTPS or localhost)
        if (!window.isSecureContext) {
            setMicError("Microphone access requires a secure (HTTPS) connection.");
            return;
        }

        if (!navigator.mediaDevices?.getUserMedia) {
            setMicError("Microphone not available on this browser.");
            return;
        }

        try {
            // Call getUserMedia directly inside the user-gesture handler
            // so the browser shows its native permission prompt naturally.
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            setMicError(null);
            const mr = new MediaRecorder(stream);
            recordingChunksRef.current = [];
            mr.ondataavailable = (e) => { if (e.data.size > 0) recordingChunksRef.current.push(e.data); };
            mr.onstop = () => {
                // Use base MIME type (strip codec params) so the backend doesn't reject it
                const baseType = (mr.mimeType || "audio/webm").split(";")[0].trim();
                const blob = new Blob(recordingChunksRef.current, { type: baseType });
                audioBlobRef.current = blob;
                setAudioPreviewUrl(URL.createObjectURL(blob));
                stream.getTracks().forEach(t => t.stop());
            };
            mr.start();
            mediaRecorderRef.current = mr;
            setIsRecording(true);
            setRecordingSecs(0);
            recordingTimerRef.current = setInterval(() => setRecordingSecs(s => s + 1), 1000);
        } catch (err) {
            if (err instanceof Error && err.name === "NotAllowedError") {
                // NotAllowedError fires when:
                //   - The user denied the prompt
                //   - A Permissions-Policy header blocks microphone (e.g. microphone=())
                //   - The user has previously denied and the browser doesn't re-prompt
                setMicError("Microphone access denied. Check your browser settings and site permissions (look for the lock icon in the address bar), then reload and try again.");
            } else if (err instanceof Error && err.name === "NotFoundError") {
                setMicError("No microphone found. Plug one in and try again.");
            } else if (err instanceof Error && err.name === "NotReadableError") {
                setMicError("Microphone is busy. Close other apps using it and try again.");
            } else {
                setMicError("Could not start recording. Check your microphone and try again.");
            }
        }
    };

    const stopRecording = () => {
        mediaRecorderRef.current?.stop();
        setIsRecording(false);
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    };

    const discardVoice = () => {
        if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl);
        audioBlobRef.current = null;
        setAudioPreviewUrl(null);
        setRecordingSecs(0);
    };

    const sendVoice = async () => {
        if (!audioBlobRef.current || isSending) return;
        setIsSending(true);
        setMicError(null);
        try {
            const form = new FormData();
            form.append("file", audioBlobRef.current, `voice-${Date.now()}.webm`);
            const uploadRes = await fetch("/api/chat/voice", { method: "POST", body: form });
            if (!uploadRes.ok) {
                let errMsg = "Voice upload failed";
                try { const body = await uploadRes.json(); if (body.error) errMsg = body.error; } catch {}
                throw new Error(errMsg);
            }
            const { url } = await uploadRes.json() as { url: string };

            const secs = recordingSecs;
            const mins = Math.floor(secs / 60);
            const durationLabel = mins > 0 ? `${mins}:${String(secs % 60).padStart(2, "0")}` : `${secs}s`;
            const text = `🎤 Voice message (${durationLabel})\n[audio:${url}]`;

            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text, targetAgentId: agentId }),
            });
            if (!res.ok) {
                let errMsg = "Failed to send message";
                try { const body = await res.json(); if (body.error) errMsg = body.error; } catch {}
                throw new Error(errMsg);
            }
            const data = await res.json() as { thread?: DirectThread; message?: DirectMessage };
            if (data.thread) setThread(data.thread);
            if (data.message) {
                setMessages(prev => prev.some(m => m.id === data.message!.id) ? prev : [...prev, data.message!]);
                lastSeenAtRef.current = data.message.createdAt;
            }
            discardVoice();
        } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            console.error("Failed to send voice message", err);
            setMicError(message);
        } finally {
            setIsSending(false);
        }
    };


    const handleSend = async (event: React.FormEvent) => {
        event.preventDefault();
        const text = draft.trim();
        if (!text || isSending) return;

        setIsSending(true);
        setDraft("");

        try {
            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text, targetAgentId: agentId }),
            });

            if (!res.ok) {
                throw new Error("Failed to send direct message");
            }

            const data = await res.json() as { thread?: DirectThread; message?: DirectMessage };
            if (data.thread) {
                setThread(data.thread);
            }
            if (data.message) {
                setMessages((prev) => prev.some((message) => message.id === data.message!.id) ? prev : [...prev, data.message!]);
                lastSeenAtRef.current = data.message.createdAt;
            }
        } catch (error) {
            console.error("Failed to send direct message", error);
            setDraft(text);
        } finally {
            setIsSending(false);
        }
    };

    const isAgentTyping = participants.some(p =>
        p.participantType === 'agent' &&
        p.typingUntil &&
        new Date(p.typingUntil).getTime() > Date.now()
    );

    const agentLastReadAt = participants.find(p => p.participantType === 'agent')?.lastReadAt;

    return (
        <div className={cn("bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden h-full flex flex-col", hideHeader && "bg-transparent border-none rounded-none shadow-none")}>
            {!hideHeader && (
                <div className="flex items-center justify-between gap-4 p-5 border-b border-zinc-800 bg-zinc-900/40">
                    <div>
                        <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                                <Bot className="w-4 h-4 text-emerald-400" />
                            </div>
                            <div>
                                <h2 className="text-lg font-medium text-zinc-100">Direct Chat</h2>
                                <p className="text-xs text-zinc-500">
                                    Dedicated human-to-agent thread for {agentName}. Team, task, and attention threads stay under `Threads`.
                                </p>
                            </div>
                        </div>
                    </div>
                    <div className="text-right">
                        <div className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500">Thread</div>
                        <div className="text-xs font-mono text-zinc-400">{thread?.id || "provisioning"}</div>
                    </div>
                </div>
            )}

            <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.08),_transparent_35%),linear-gradient(180deg,rgba(24,24,27,0.55),rgba(9,9,11,0.95))]">
                {isLoading ? (
                    <div className="h-full flex items-center justify-center text-sm text-zinc-500 animate-pulse">
                        Loading direct thread...
                    </div>
                ) : messages.length === 0 ? (
                    <div className="h-full flex items-center justify-center">
                        <div className="max-w-sm rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/50 p-6 text-center">
                            <div className="text-sm text-zinc-300 mb-2">No direct messages yet.</div>
                            <div className="text-xs text-zinc-500 leading-relaxed">
                                Send an instruction here and the connected agent should answer inside this private thread.
                            </div>
                        </div>
                    </div>
                ) : (
                    <div>
                        {hasOlderMessages && (
                            <div className="mb-4 flex justify-center">
                                <button
                                    type="button"
                                    onClick={loadOlderMessages}
                                    disabled={isLoadingOlder}
                                    className="rounded-full border border-zinc-800 bg-zinc-950/80 px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-emerald-500/40 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {isLoadingOlder ? "Loading..." : "Load older messages"}
                                </button>
                            </div>
                        )}
                        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
                        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                            const i = virtualRow.index;
                            const message = messages[i];
                            const isHuman = message.senderType === "human";
                            const isRead = isHuman && agentLastReadAt && new Date(agentLastReadAt).getTime() >= new Date(message.createdAt).getTime();
                            const prev = messages[i - 1] ?? null;
                            const next = messages[i + 1] ?? null;

                            const showDaySep = !prev || !isSameDay(prev.createdAt, message.createdAt);
                            const isContinuation = !!prev && isGroupContinuation(message, prev);
                            const isLastInGroup = !next || !isGroupContinuation(next, message);

                            return (
                                <div
                                    key={message.id}
                                    ref={rowVirtualizer.measureElement}
                                    data-index={i}
                                    style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}
                                >
                                    {showDaySep && (
                                        <div className="flex items-center gap-2 my-4">
                                            <div className="flex-1 border-t border-zinc-800" />
                                            <span className="text-[10px] uppercase tracking-widest text-zinc-600">{dateSeparatorLabel(message.createdAt)}</span>
                                            <div className="flex-1 border-t border-zinc-800" />
                                        </div>
                                    )}

                                    <div className={cn(
                                        `flex ${isHuman ? "justify-end" : "justify-start"}`,
                                        isContinuation ? "mt-0.5" : "mt-3"
                                    )}>
                                        <div className={cn("flex min-w-0 max-w-[80%] flex-col", isHuman ? "items-end" : "items-start")}>
                                            {/* Agent name label — only on group-start agent messages */}
                                            {!isHuman && !isContinuation && (
                                                <span className="text-[10px] font-medium text-zinc-400 mb-1 ml-1">{agentName}</span>
                                            )}

                                            <div className={cn(
                                                `min-w-0 max-w-full rounded-2xl border px-4 py-3 shadow-sm`,
                                                isHuman
                                                    ? "bg-emerald-500 text-emerald-950 border-emerald-400/40"
                                                    : "bg-zinc-950/85 text-zinc-200 border-zinc-800",
                                                isLastInGroup && isHuman && "rounded-br-none",
                                                isLastInGroup && !isHuman && "rounded-bl-none"
                                            )}>
                                                {/* Header row — only on group-start */}
                                                {!isContinuation && (
                                                    <div className="flex items-center gap-2 mb-2">
                                                        <div className={cn("w-5 h-5 rounded-full flex items-center justify-center", isHuman ? "bg-emerald-950/15" : "bg-zinc-800")}>
                                                            {isHuman ? <User className="w-3 h-3" /> : <Bot className="w-3 h-3 text-emerald-400" />}
                                                        </div>
                                                        <span className={cn("text-[10px] uppercase tracking-wider font-bold", isHuman ? "text-emerald-950/70" : "text-zinc-500")}>
                                                            {isHuman ? "You" : agentName}
                                                        </span>
                                                    </div>
                                                )}
                                                <MessageContent text={message.text} isHuman={isHuman} />
                                                {/* Timestamp — bottom-right of bubble, on every message */}
                                                <div className={cn("text-[10px] mt-1.5 text-right opacity-50", isHuman ? "text-emerald-950" : "text-zinc-400")}>
                                                    {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                                </div>
                                            </div>

                                            {/* Read receipt — only on human messages */}
                                            {isHuman && isLastInGroup && (
                                                <div className="mt-1 flex items-center gap-1 px-1">
                                                    <span className={cn("text-[10px] font-medium transition-colors", isRead ? "text-emerald-500" : "text-zinc-600")}>
                                                        {isRead ? "Read" : "Sent"}
                                                    </span>
                                                    {isRead && <div className="w-1 h-1 rounded-full bg-emerald-500" />}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                        </div>
                        {isAgentTyping && (
                            <div className="flex justify-start mt-3 animate-in fade-in slide-in-from-left-2 duration-300">
                                <div className="bg-zinc-900 border border-zinc-800 rounded-2xl px-4 py-3 flex items-center gap-2">
                                    <div className="flex gap-1">
                                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-bounce [animation-delay:-0.3s]" />
                                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-bounce [animation-delay:-0.15s]" />
                                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-bounce" />
                                    </div>
                                    <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">
                                        {agentName} is typing
                                    </span>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            <div className="border-t border-zinc-800 bg-zinc-950/80 p-4 space-y-2">
                {micError && (
                    <div className="flex items-start gap-2 rounded-lg bg-red-900/40 border border-red-700/40 px-3 py-2 text-xs text-red-300">
                        <Mic className="w-3.5 h-3.5 shrink-0 text-red-400 mt-0.5" />
                        <span>
                            {micError === "blocked"
                                ? <>Microphone is blocked. Click the <strong>lock icon</strong> in your browser&apos;s address bar → <strong>Site settings</strong> → set Microphone to <strong>Allow</strong>, then reload the page.</>
                                : micError}
                        </span>
                    </div>
                )}
                {/* State: recording in progress */}
                {isRecording && (
                    <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2 flex-1">
                            <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shrink-0" />
                            <span className="text-sm font-medium text-zinc-300">Recording…</span>
                            <span className="text-sm font-mono text-zinc-400">
                                {Math.floor(recordingSecs / 60)}:{String(recordingSecs % 60).padStart(2, "0")}
                            </span>
                        </div>
                        <button
                            type="button"
                            onClick={stopRecording}
                            className="inline-flex items-center gap-2 rounded-full bg-red-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-400 transition-colors"
                        >
                            <Square className="w-3.5 h-3.5 fill-white" />
                            Stop
                        </button>
                    </div>
                )}

                {/* State: preview before sending */}
                {!isRecording && audioPreviewUrl && (
                    <div className="flex items-center gap-2">
                        <audio controls src={audioPreviewUrl} className="flex-1 h-9 min-w-0" style={{ colorScheme: "dark" }} />
                        <button
                            type="button"
                            onClick={discardVoice}
                            className="p-2 rounded-full hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
                            title="Discard"
                        >
                            <Trash2 className="w-4 h-4" />
                        </button>
                        <button
                            type="button"
                            onClick={sendVoice}
                            disabled={isSending}
                            className="inline-flex items-center gap-2 rounded-full bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            <Send className="w-4 h-4" />
                            Send
                        </button>
                    </div>
                )}

                {/* State: normal text input */}
                {!isRecording && !audioPreviewUrl && (
                <form onSubmit={handleSend}>
                <div className="flex items-center gap-3">
                    <input
                        type="text"
                        value={draft}
                        onChange={(event) => handleTyping(event.target.value)}
                        placeholder={`Message ${agentName} directly...`}
                        className="flex-1 bg-zinc-900 border border-zinc-800 rounded-full px-4 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                    <button
                        type="button"
                        onClick={startRecording}
                        title="Record voice message"
                        className="flex items-center justify-center w-10 h-10 rounded-full bg-zinc-800 border border-zinc-700 hover:border-emerald-500/50 hover:text-emerald-400 text-zinc-400 transition-colors shrink-0"
                    >
                        <Mic className="w-4 h-4" />
                    </button>
                    <button
                        type="submit"
                        disabled={!draft.trim() || isSending}
                        className="inline-flex items-center gap-2 rounded-full bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-emerald-950 transition-colors hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Send className="w-4 h-4" />
                        {isSending ? "Sending" : "Send"}
                    </button>
                </div>
            </form>
                )}
            </div>
        </div>
    );
}

function MessageContent({ text, isHuman }: { text: string; isHuman: boolean }) {
    const audioMatch = text.match(/\[audio:(https?:\/\/[^\]]+)\]/);
    if (!audioMatch) {
        return (
            <MarkdownRenderer
                content={text}
                className="break-words [&_.prose]:max-w-prose [&_.prose]:text-sm [&_.prose]:leading-relaxed [&_.prose_p:first-child]:mt-0 [&_.prose_p:last-child]:mb-0 [&_.prose_p]:mb-3 [&_.prose_ul]:mb-3 [&_.prose_ol]:mb-3 [&_.prose_pre]:mb-3 [&_.prose_pre]:bg-zinc-950/70 [&_.prose_pre]:border-zinc-800/80 [&_.prose_code]:text-emerald-200 [&_.prose_a]:text-emerald-300"
            />
        );
    }
    const before = text.slice(0, audioMatch.index).replace(/\[audio:[^\]]+\]/, "").trim();
    const audioSrc = audioMatch[1];
    return (
        <div className="space-y-2">
            {before && <p className={`text-sm font-medium ${isHuman ? "text-emerald-950/80" : "text-zinc-400"}`}>{before}</p>}
            <audio
                controls
                src={audioSrc}
                className="w-full max-w-[220px] h-8"
                style={{ colorScheme: "dark", accentColor: isHuman ? "#6ee7b7" : "#6366f1" }}
            />
        </div>
    );
}
