"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
    IconAlertTriangle,
    IconCircleCheck,
    IconCpu,
    IconDeviceDesktop,
    IconLoader2,
    IconLock,
    IconRefresh,
    IconTrash,
    IconUsb,
    IconWifi,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { useFormatter, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { FirmwareManifest } from "@/lib/throne-display/firmware-manifest";
import {
    advanceProvision,
    checkDisplayServer,
    encodeProvisionCommand,
    initialProvisionProgress,
    isFirmwareCurrent,
    mergeScanNetworks,
    signalBars,
    type ProvisionFailure,
    type ProvisionProgress,
    type ScanNetwork,
} from "@/lib/throne-display/serial-protocol";
import { DisplaySerialSession, isWebSerialSupported, reconnectDisplay, requestDisplayPort } from "@/lib/throne-display/web-serial";

export type DisplayToken = {
    id: string;
    name: string;
    scope: string;
    createdAt: string;
    lastUsedAt: string | null;
    includePrivateChats?: boolean;
    includeAgentThoughts?: boolean;
};

type Step = "connect" | "firmware" | "wifi" | "options" | "finish";

/** Labelled by settings.displays.steps.<id>. */
const STEPS: Step[] = ["connect", "firmware", "wifi", "options", "finish"];

const OTHER = "__other__";
// Stored on the server and shown to the whole company, so it stays English like other stored defaults.
const DEFAULT_DISPLAY_NAME = "Desk display";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const noSubscribe = () => () => undefined;
const originProblem = () => {
    const check = checkDisplayServer(window.location.origin);
    return check.ok ? null : check.error;
};

type DisplaysT = ReturnType<typeof useTranslations<"settings.displays">>;

function failureText(t: DisplaysT, failure: ProvisionFailure | null, ssid: string, detail: string | null): string {
    switch (failure) {
        case "wrong_password": return t("failure.wrongPassword", { ssid });
        case "no_network": return t("failure.noNetwork", { ssid });
        case "wifi_timeout": return t("failure.wifiTimeout", { ssid });
        case "token_rejected": return t("failure.tokenRejected");
        case "rejected_config": return t("failure.rejectedConfig", { detail: detail ?? t("failure.invalid") });
        default: return t("failure.other");
    }
}

function phaseText(t: DisplaysT, p: ProvisionProgress, usbLost: boolean): string {
    switch (p.phase) {
        case "sending": return t("phase.sending");
        case "restarting": return t("phase.restarting");
        case "joining_wifi": return usbLost ? t("phase.waitingOnline") : t("phase.joiningWifi");
        case "wifi_connected": return p.lastFetchStatus && p.lastFetchStatus !== 200 ? t("phase.serverAnswered", { status: p.lastFetchStatus }) : t("phase.contacting");
        case "live": return t("live");
        default: return "";
    }
}

export function DisplaysTab({
    tokens,
    onTokenCreated,
    onTokenRemoved,
    onRevoke,
    revokingTokenId,
    confirmingRevokeId,
}: {
    tokens: DisplayToken[];
    onTokenCreated: (token: DisplayToken) => void;
    /** A key minted by the wizard was revoked because setup did not finish. */
    onTokenRemoved: (tokenId: string) => void;
    onRevoke: (tokenId: string) => void;
    revokingTokenId: string | null;
    confirmingRevokeId: string | null;
}) {
    const t = useTranslations("settings.displays");
    const tc = useTranslations("common");
    const format = useFormatter();
    // null while server-rendering; Web Serial support never changes at runtime.
    const supported = useSyncExternalStore(noSubscribe, isWebSerialSupported, () => null);
    // The display talks to this page's own origin; refuse plain http on a public host.
    const serverProblem = useSyncExternalStore(noSubscribe, originProblem, () => null);
    const [step, setStep] = useState<Step>("connect");
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [connected, setConnected] = useState(false);

    const [manifest, setManifest] = useState<FirmwareManifest | null>(null);
    const [boardVersion, setBoardVersion] = useState<string | null>(null);
    const [flash, setFlash] = useState<{ percent: number; label: string } | null>(null);

    const [networks, setNetworks] = useState<ScanNetwork[]>([]);
    const [scanning, setScanning] = useState(false);
    const [ssidChoice, setSsidChoice] = useState("");
    const [otherSsid, setOtherSsid] = useState("");
    const [password, setPassword] = useState("");

    const [displayName, setDisplayName] = useState(DEFAULT_DISPLAY_NAME);
    const [privateChats, setPrivateChats] = useState(false);
    const [agentThoughts, setAgentThoughts] = useState(true);

    const [progress, setProgress] = useState<ProvisionProgress>(initialProvisionProgress);
    const [usbLost, setUsbLost] = useState(false);
    const [timedOut, setTimedOut] = useState(false);

    const sessionRef = useRef<DisplaySerialSession | null>(null);
    const portRef = useRef<SerialPort | null>(null);
    // The minted display key lives only in memory, only until the board confirms it.
    const mintedRef = useRef<{ id: string; secret: string; includePrivateChats: boolean; includeAgentThoughts: boolean } | null>(null);
    const runRef = useRef(0);

    // Leaving the tab stops any running flow and releases the port.
    // A key that never went live is revoked (best effort, never blocks the UI), so
    // abandoned or failed setups leave no usable token behind.
    const onTokenRemovedRef = useRef(onTokenRemoved);
    useEffect(() => {
        onTokenRemovedRef.current = onTokenRemoved;
    }, [onTokenRemoved]);
    const revokeUnused = useCallback(() => {
        const minted = mintedRef.current;
        mintedRef.current = null;
        if (!minted) return;
        // keepalive lets the request finish even when the page is being left.
        void fetch(`/api/settings/tokens/${minted.id}`, { method: "DELETE", keepalive: true })
            .then((res) => {
                if (res.ok) onTokenRemovedRef.current(minted.id);
            })
            .catch(() => undefined);
    }, []);
    const stopAll = useCallback(() => {
        runRef.current++;
        revokeUnused();
        void sessionRef.current?.close();
    }, [revokeUnused]);
    useEffect(() => stopAll, [stopAll]);

    const ssid = ssidChoice === OTHER ? otherSsid : ssidChoice;
    const selectedNetwork = networks.find((n) => n.ssid === ssidChoice);
    // A network the display saw as open never gets a password, even one typed earlier.
    const effectivePassword = selectedNetwork?.secure === false ? "" : password;
    const displayTokens = tokens.filter((token) => token.scope === "read_only");

    const attachSession = useCallback((session: DisplaySerialSession) => {
        sessionRef.current = session;
        portRef.current = session.port;
        setConnected(true);
        session.onClose(() => {
            if (sessionRef.current === session) {
                sessionRef.current = null;
                setConnected(false);
            }
        });
    }, []);

    const ensureSession = useCallback(async (timeoutMs = 8000): Promise<DisplaySerialSession | null> => {
        if (sessionRef.current && !sessionRef.current.closed) return sessionRef.current;
        const session = await reconnectDisplay(timeoutMs, portRef.current ?? undefined);
        if (session) attachSession(session);
        return session;
    }, [attachSession]);

    const loadManifest = useCallback(async () => {
        const { fetchFirmwareManifest } = await import("@/lib/throne-display/flasher");
        const m = await fetchFirmwareManifest();
        setManifest(m);
        return m;
    }, []);

    // ------------------------------------------------------------ step 1: connect

    const connect = async () => {
        setError(null);
        let port: SerialPort;
        try {
            port = await requestDisplayPort();
        } catch {
            return; // the user closed the picker
        }
        setBusy(t("busy.connecting"));
        try {
            await sessionRef.current?.close();
            const session = await DisplaySerialSession.open(port);
            attachSession(session);
            const [, version] = await Promise.all([loadManifest().catch((e: Error) => { setError(e.message); return null; }), session.queryVersion()]);
            setBoardVersion(version);
            setStep("firmware");
        } catch (e) {
            setError(e instanceof Error && /open/i.test(e.message)
                ? t("errors.portBusy")
                : t("errors.connect", { error: e instanceof Error ? e.message : String(e) }));
        } finally {
            setBusy(null);
        }
    };

    // ------------------------------------------------------------ step 2: firmware

    const installFirmware = async () => {
        if (!manifest || !portRef.current) return;
        setError(null);
        setBusy(t("busy.installing"));
        setFlash({ percent: 0, label: t("flash.downloading") });
        try {
            const { downloadFirmwareImages, flashDisplayFirmware } = await import("@/lib/throne-display/flasher");
            const images = await downloadFirmwareImages(manifest);
            const port = portRef.current;
            await sessionRef.current?.close();
            sessionRef.current = null;
            setConnected(false);
            await flashDisplayFirmware(port, manifest, images, setFlash);
            setFlash({ percent: 100, label: t("flash.waitingRestart") });
            await sleep(1500);
            const session = await ensureSession(20000);
            if (!session) {
                setError(t("errors.noReconnect"));
                return;
            }
            const version = await session.queryVersion(6000);
            setBoardVersion(version);
            if (!isFirmwareCurrent(version, manifest.version)) {
                setError(t("errors.wrongVersion", { version: version ?? t("errors.nothing") }));
                return;
            }
            toast.success(t("firmwareInstalled", { version: manifest.version }));
            goToWifi();
        } catch (e) {
            setError(t("errors.install", { error: e instanceof Error ? e.message : String(e) }));
        } finally {
            setBusy(null);
            setFlash(null);
        }
    };

    const reconnect = async () => {
        setError(null);
        let port: SerialPort;
        try {
            port = await requestDisplayPort();
        } catch {
            return;
        }
        try {
            const session = await DisplaySerialSession.open(port);
            attachSession(session);
            setBoardVersion(await session.queryVersion());
        } catch (e) {
            setError(t("errors.reconnect", { error: e instanceof Error ? e.message : String(e) }));
        }
    };

    // ------------------------------------------------------------ step 3: Wi-Fi

    const scan = useCallback(async () => {
        setError(null);
        setScanning(true);
        try {
            const session = await ensureSession();
            if (!session) {
                setError(t("errors.notConnected"));
                return;
            }
            for (let attempt = 0; attempt < 2; attempt++) {
                const found: ScanNetwork[] = [];
                const off = session.onEvent((e) => {
                    if (e.kind === "scan_network") found.push(e.network);
                });
                const result = session.waitFor((e) => (e.kind === "scan_done" ? "done" : e.kind === "scan_error" ? e.reason : undefined), 20000);
                await session.send("scan");
                const outcome = await result;
                off();
                if (outcome === "done") {
                    const merged = mergeScanNetworks(found);
                    setNetworks(merged);
                    setSsidChoice((prev) => prev || (merged[0]?.ssid ?? OTHER));
                    return;
                }
                if (outcome === "busy") await sleep(3000);
                else await sleep(800);
            }
            setError(t("errors.scanEmpty"));
        } catch (e) {
            setError(t("errors.scan", { error: e instanceof Error ? e.message : String(e) }));
        } finally {
            setScanning(false);
        }
    }, [ensureSession, t]);

    const goToWifi = () => {
        setStep("wifi");
        if (networks.length === 0 && !scanning) void scan();
    };

    const wifiValid = () => {
        const probe = encodeProvisionCommand({ ssid, password: effectivePassword, server: "https://x.example", token: "probe" });
        if (!probe.ok && (probe.field === "ssid" || probe.field === "password")) return probe.error;
        if (selectedNetwork?.secure && !password) return t("errors.needsPassword");
        return null;
    };

    // ------------------------------------------------------------ step 5: finish

    const provision = async () => {
        const run = ++runRef.current;
        setStep("finish");
        setError(null);
        setUsbLost(false);
        setTimedOut(false);
        let state: ProvisionProgress = initialProvisionProgress;
        setProgress(state);
        const apply = (next: ProvisionProgress) => {
            state = next;
            if (run === runRef.current) setProgress(next);
        };

        try {
            const session = await ensureSession();
            if (!session) throw new Error(t("errors.notConnectedRetry"));

            // A key from an earlier attempt is reused unless its options changed.
            if (mintedRef.current && (mintedRef.current.includePrivateChats !== privateChats || mintedRef.current.includeAgentThoughts !== agentThoughts)) revokeUnused();
            if (!mintedRef.current) {
                const res = await fetch("/api/settings/tokens", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: displayName.trim() || DEFAULT_DISPLAY_NAME, scope: "read_only", ...(privateChats ? { includePrivateChats: true } : {}), ...(agentThoughts ? { includeAgentThoughts: true } : {}) }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || t("errors.createKey"));
                mintedRef.current = { id: data.token.id, secret: data.secret, includePrivateChats: privateChats, includeAgentThoughts: agentThoughts };
                onTokenCreated(data.token);
            }
            const minted = mintedRef.current;
            const encoded = encodeProvisionCommand({ ssid, password: effectivePassword, server: window.location.origin, token: minted.secret });
            if (!encoded.ok) throw new Error(encoded.error);

            const follow = (s: DisplaySerialSession) => s.onEvent((e) => apply(advanceProvision(state, e)));
            let off = follow(session);
            const ack = session.waitFor((e) => (e.kind === "provision_ok" ? true : e.kind === "provision_error" ? false : undefined), 6000);
            await session.send(encoded.command);
            const ok = await ack;
            if (ok === false) return; // advanceProvision recorded rejected_config
            if (ok === null && state.phase === "sending") throw new Error(t("errors.noAnswer"));

            // The board restarts; its USB port may vanish for a moment. Meanwhile the
            // server sees the key's first use, which proves the display is live even
            // when USB never comes back.
            const deadline = Date.now() + 90000;
            let nextPoll = Date.now() + 4000;
            let lastReconnect = 0;
            while (run === runRef.current && state.phase !== "live" && Date.now() < deadline) {
                if (state.phase === "failed" && (state.failure === "rejected_config" || state.failure === "token_rejected")) break;
                if (!sessionRef.current || sessionRef.current.closed) {
                    off();
                    if (Date.now() - lastReconnect > 1000) {
                        lastReconnect = Date.now();
                        const again = await reconnectDisplay(2500, portRef.current ?? undefined);
                        if (again) {
                            attachSession(again);
                            off = follow(again);
                            setUsbLost(false);
                        } else {
                            setUsbLost(true);
                        }
                    }
                }
                if (Date.now() >= nextPoll) {
                    nextPoll = Date.now() + 3000;
                    const res = await fetch("/api/settings/tokens", { cache: "no-store" }).catch(() => null);
                    const data = res?.ok ? await res.json().catch(() => null) : null;
                    const seen = (data?.tokens as DisplayToken[] | undefined)?.find((token) => token.id === minted.id);
                    if (seen?.lastUsedAt) apply({ ...state, phase: "live", failure: null });
                }
                await sleep(400);
            }
            off();
            if (run !== runRef.current) return;
            if (state.phase === "live") {
                mintedRef.current = null; // the board owns the key now
                toast.success(t("live"));
            } else if (state.phase !== "failed") {
                setTimedOut(true);
            }
        } catch (e) {
            if (run === runRef.current) setError(e instanceof Error ? e.message : String(e));
        }
        // Rejected, failed or timed out: the key never reached the server, so revoke
        // it; the next attempt creates a fresh one.
        if (run === runRef.current && state.phase !== "live") revokeUnused();
    };

    const startOver = () => {
        runRef.current++;
        revokeUnused();
        setProgress(initialProvisionProgress);
        setError(null);
        setTimedOut(false);
        setStep(sessionRef.current ? "wifi" : "connect");
    };

    // ------------------------------------------------------------ render

    const stepIndex = STEPS.indexOf(step);
    const failed = progress.phase === "failed";
    const live = progress.phase === "live";

    return (
        <section className="grid gap-4 sm:gap-6 grid-cols-1 lg:grid-cols-[minmax(0,1.3fr)_minmax(300px,1fr)]">
            <div className="emperor-panel rounded-2xl sm:rounded-2xl p-4 sm:p-6">
                <h2 className="flex items-center text-lg font-semibold text-foreground">
                    <IconDeviceDesktop className="mr-2 h-5 w-5 text-primary" /> {t("title")}
                </h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {t("intro")}
                </p>

                {serverProblem && (
                    <div className="mt-4 flex items-start gap-3 rounded-xl border border-red-500/25 bg-red-500/[0.07] p-3 text-sm text-red-700 dark:text-red-100/85">
                        <IconLock className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{serverProblem}</span>
                    </div>
                )}

                {supported === false && (
                    <div className="mt-4 flex items-start gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-3 text-sm text-amber-800 dark:text-amber-100/85">
                        <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{t("unsupported")}</span>
                    </div>
                )}

                <ol className="mt-5 flex flex-wrap gap-1.5" aria-label={t("setupSteps")}>
                    {STEPS.map((s, i) => (
                        <li
                            key={s}
                            aria-current={s === step ? "step" : undefined}
                            className={cn(
                                "rounded-full border px-3 py-1 text-xs font-medium",
                                s === step ? "border-cyan-400/40 bg-cyan-400/10 text-primary" : i < stepIndex ? "border-emerald-500/25 text-emerald-700 dark:text-emerald-200/80" : "border-border text-muted-foreground",
                            )}
                        >
                            {i + 1}. {t(`steps.${s}`)}
                        </li>
                    ))}
                </ol>

                <div className="mt-5 space-y-4">
                    {step === "connect" && (
                        <div className="space-y-3">
                            <p className="text-sm text-muted-foreground">{t("connectHint")}</p>
                            <Button onClick={connect} disabled={!supported || !!serverProblem || !!busy}>
                                {busy ? <IconLoader2 className="h-4 w-4 animate-spin" /> : <IconUsb className="h-4 w-4" />} {busy ?? t("connect")}
                            </Button>
                        </div>
                    )}

                    {step === "firmware" && (
                        <div className="space-y-3">
                            <div className="rounded-xl border border-border bg-muted/30 p-4 text-sm">
                                <div className="flex items-center gap-2 text-foreground"><IconCpu className="h-4 w-4 text-primary" /> {t("firmwareTitle")}</div>
                                <p className="mt-2 text-muted-foreground">
                                    {t("onDisplay")} <span className="font-mono text-foreground">{boardVersion === "unknown" ? t("olderVersion") : boardVersion ?? t("notDetected")}</span>
                                    {" · "}{t("latest")} <span className="font-mono text-foreground">{manifest?.version ?? t("unavailable")}</span>
                                </p>
                            </div>
                            {flash && (
                                <div>
                                    <div className="h-2 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.06]" role="progressbar" aria-valuenow={flash.percent} aria-valuemin={0} aria-valuemax={100}>
                                        <div className="h-full rounded-full bg-cyan-400 transition-[width] duration-300" style={{ width: `${flash.percent}%` }} />
                                    </div>
                                    <p className="mt-2 text-xs text-muted-foreground">{flash.label} · {flash.percent}%</p>
                                </div>
                            )}
                            <div className="flex flex-wrap gap-2">
                                {manifest && isFirmwareCurrent(boardVersion, manifest.version) ? (
                                    <>
                                        <Button onClick={goToWifi} disabled={!!busy}>{t("skipInstalled")}</Button>
                                        <Button variant="outline" onClick={installFirmware} disabled={!!busy || !connected}>{t("reinstall")}</Button>
                                    </>
                                ) : (
                                    <Button onClick={installFirmware} disabled={!!busy || !manifest || !portRef.current}>
                                        {busy ? <IconLoader2 className="h-4 w-4 animate-spin" /> : <IconCpu className="h-4 w-4" />} {busy ?? t("installFirmware", { version: manifest?.version ?? "" })}
                                    </Button>
                                )}
                                {!connected && !busy && <Button variant="outline" onClick={reconnect}><IconUsb className="h-4 w-4" /> {t("reconnect")}</Button>}
                            </div>
                            <p className="text-xs leading-5 text-muted-foreground">{t("installHint")}</p>
                        </div>
                    )}

                    {step === "wifi" && (
                        <div className="space-y-3">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-medium text-foreground">{t("wifiNetwork")}</span>
                                <Button size="sm" variant="ghost" onClick={() => void scan()} disabled={scanning}>
                                    <IconRefresh className={cn("h-4 w-4", scanning && "animate-spin")} /> {scanning ? t("scanning") : t("scanAgain")}
                                </Button>
                            </div>
                            <div className="max-h-72 divide-y divide-border overflow-y-auto rounded-xl border border-border" role="radiogroup" aria-label={t("wifiNetworks")}>
                                {networks.length === 0 && (
                                    <div className="p-4 text-sm text-muted-foreground">{scanning ? t("looking") : t("noNetworks")}</div>
                                )}
                                {networks.map((n) => (
                                    <label key={n.ssid} className={cn("flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm", ssidChoice === n.ssid ? "bg-cyan-400/[0.07]" : "hover:bg-black/[0.04] dark:hover:bg-white/[0.03]")}>
                                        <input type="radio" name="display-ssid" className="accent-cyan-400" checked={ssidChoice === n.ssid} onChange={() => setSsidChoice(n.ssid)} />
                                        <span className="min-w-0 flex-1 truncate text-foreground">{n.ssid}</span>
                                        {n.secure && <IconLock className="h-3.5 w-3.5 text-muted-foreground" aria-label={t("passwordProtected")} />}
                                        <SignalBars rssi={n.rssi} />
                                    </label>
                                ))}
                                <label className={cn("flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm", ssidChoice === OTHER ? "bg-cyan-400/[0.07]" : "hover:bg-black/[0.04] dark:hover:bg-white/[0.03]")}>
                                    <input type="radio" name="display-ssid" className="accent-cyan-400" checked={ssidChoice === OTHER} onChange={() => setSsidChoice(OTHER)} />
                                    <span className="text-foreground">{t("otherNetwork")}</span>
                                </label>
                            </div>
                            {ssidChoice === OTHER && (
                                <Input placeholder={t("networkName")} value={otherSsid} onChange={(e) => setOtherSsid(e.target.value)} aria-label={t("networkName")} autoComplete="off" />
                            )}
                            <p className="text-xs leading-5 text-muted-foreground">
                                <IconWifi className="mr-1 inline h-3.5 w-3.5" />
                                {t("band24Hint")}
                            </p>
                            {(ssidChoice === OTHER || selectedNetwork?.secure !== false) && (
                                <label className="block space-y-2">
                                    <span className="text-sm font-medium text-foreground">{t("wifiPassword")}</span>
                                    <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" placeholder={ssidChoice === OTHER ? t("openNetworkHint") : ""} />
                                </label>
                            )}
                            <div className="flex flex-wrap items-center gap-2">
                                <Button
                                    onClick={() => {
                                        const problem = wifiValid();
                                        if (problem) setError(problem);
                                        else {
                                            setError(null);
                                            setStep("options");
                                        }
                                    }}
                                    disabled={!ssid || scanning}
                                >
                                    {t("continue")}
                                </Button>
                                {!connected && <Button variant="outline" onClick={reconnect}><IconUsb className="h-4 w-4" /> {t("reconnect")}</Button>}
                            </div>
                        </div>
                    )}

                    {step === "options" && (
                        <div className="space-y-4">
                            <label className="block space-y-2">
                                <span className="text-sm font-medium text-foreground">{t("displayName")}</span>
                                <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={80} />
                                <span className="block text-xs text-muted-foreground">{t("displayNameHint")}</span>
                            </label>
                            <label className="flex items-start gap-3 rounded-xl border border-border bg-black/[0.03] dark:bg-white/[0.02] p-3">
                                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-cyan-400" checked={privateChats} onChange={(e) => setPrivateChats(e.target.checked)} />
                                <span className="space-y-1">
                                    <span className="block text-sm font-medium text-foreground">{t("privateChats")}</span>
                                    <span className="block text-xs leading-5 text-muted-foreground">{t("privateChatsHelp")}</span>
                                </span>
                            </label>
                            <label className="flex items-start gap-3 rounded-xl border border-border bg-black/[0.03] dark:bg-white/[0.02] p-3">
                                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-cyan-400" checked={agentThoughts} onChange={(e) => setAgentThoughts(e.target.checked)} />
                                <span className="space-y-1">
                                    <span className="block text-sm font-medium text-foreground">{t("agentThoughts")}</span>
                                    <span className="block text-xs leading-5 text-muted-foreground">{t("agentThoughtsHelp")}</span>
                                </span>
                            </label>
                            <div className="flex flex-wrap gap-2">
                                <Button variant="outline" onClick={() => setStep("wifi")}>{tc("back")}</Button>
                                <Button onClick={() => void provision()} disabled={!displayName.trim() || !!serverProblem}>{t("finishSetup")}</Button>
                            </div>
                        </div>
                    )}

                    {step === "finish" && (
                        <div className="space-y-4">
                            {live ? (
                                <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-4">
                                    <div className="flex items-center gap-2 font-medium text-emerald-800 dark:text-emerald-100"><IconCircleCheck className="h-5 w-5" /> {t("live")}</div>
                                    <p className="mt-1 text-sm text-emerald-700 dark:text-emerald-100/75">{t("liveBody", { ssid, host: typeof window !== "undefined" ? window.location.host : t("thisServer") })}</p>
                                </div>
                            ) : failed || error || timedOut ? (
                                <div className="rounded-2xl border border-red-500/25 bg-red-500/[0.07] p-4">
                                    <div className="flex items-center gap-2 font-medium text-red-700 dark:text-red-100"><IconAlertTriangle className="h-5 w-5" /> {t("didNotFinish")}</div>
                                    <p className="mt-1 text-sm text-red-700 dark:text-red-100/80">
                                        {error ?? (timedOut
                                            ? usbLost
                                                ? t("timedOutUsbLost")
                                                : t("timedOut", { host: typeof window !== "undefined" ? window.location.host : t("thisServer") })
                                            : failureText(t, progress.failure, ssid, progress.detail))}
                                    </p>
                                </div>
                            ) : (
                                <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 p-4 text-sm text-foreground">
                                    <IconLoader2 className="h-4 w-4 animate-spin text-primary" /> {phaseText(t, progress, usbLost)}...
                                </div>
                            )}
                            {!live && (failed || error || timedOut) && (
                                <div className="flex flex-wrap gap-2">
                                    {progress.failure !== "rejected_config" && <Button onClick={() => void provision()}>{t("tryAgain")}</Button>}
                                    <Button variant="outline" onClick={startOver}>{t("changeWifi")}</Button>
                                    {!connected && <Button variant="outline" onClick={reconnect}><IconUsb className="h-4 w-4" /> {t("reconnect")}</Button>}
                                </div>
                            )}
                            {live && (
                                <Button variant="outline" onClick={() => { setStep("connect"); setNetworks([]); setPassword(""); setProgress(initialProvisionProgress); }}>{t("setUpAnother")}</Button>
                            )}
                        </div>
                    )}

                    {error && step !== "finish" && (
                        <p className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/[0.06] p-3 text-sm text-red-700 dark:text-red-100/85">
                            <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
                        </p>
                    )}
                </div>
            </div>

            <div className="overflow-hidden rounded-2xl sm:rounded-2xl border border-border bg-background/70 self-start">
                <div className="border-b border-border p-4 sm:p-5">
                    <h2 className="text-lg font-semibold text-foreground">{t("yourDisplays")}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{t("yourDisplaysIntro")}</p>
                </div>
                <div className="divide-y divide-border">
                    {displayTokens.length === 0 ? (
                        <div className="p-8 text-center text-sm text-muted-foreground">{t("noDisplays")}</div>
                    ) : (
                        displayTokens.map((token) => (
                            <div key={token.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                                <div className="min-w-0">
                                    <h3 className="font-medium text-foreground">{token.name}</h3>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        {t("tokenDates", { created: format.dateTime(new Date(token.createdAt), { dateStyle: "medium" }), used: token.lastUsedAt ? format.dateTime(new Date(token.lastUsedAt), { dateStyle: "medium", timeStyle: "short" }) : t("never") })}
                                    </p>
                                    <p className="mt-1 text-xs text-muted-foreground">{t("tokenOptions", { privateChats: token.includePrivateChats ? "on" : "off", thoughts: token.includeAgentThoughts ? "on" : "off" })}</p>
                                </div>
                                <Button variant="destructive" size="sm" onClick={() => onRevoke(token.id)} disabled={revokingTokenId === token.id}>
                                    <IconTrash className="h-4 w-4" /> {revokingTokenId === token.id ? t("revoking") : confirmingRevokeId === token.id ? t("confirmRevoke") : t("revoke")}
                                </Button>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </section>
    );
}

function SignalBars({ rssi }: { rssi: number }) {
    const t = useTranslations("settings.displays");
    const bars = signalBars(rssi);
    return (
        <span className="flex items-end gap-0.5" aria-label={t("signal", { bars })} title={t("dbm", { rssi })}>
            {[1, 2, 3, 4].map((b) => (
                <span key={b} className={cn("w-1 rounded-sm", b <= bars ? "bg-cyan-300" : "bg-black/15 dark:bg-white/15")} style={{ height: `${b * 3 + 2}px` }} />
            ))}
        </span>
    );
}
