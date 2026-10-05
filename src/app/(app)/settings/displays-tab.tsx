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
};

type Step = "connect" | "firmware" | "wifi" | "options" | "finish";

const STEPS: { id: Step; label: string }[] = [
    { id: "connect", label: "Connect" },
    { id: "firmware", label: "Firmware" },
    { id: "wifi", label: "Wi-Fi" },
    { id: "options", label: "Options" },
    { id: "finish", label: "Finish" },
];

const OTHER = "__other__";
const PRIVATE_CHATS_HELP =
    "Shows your own direct conversations with each agent on the screen. Never includes other people's chats. Anyone who can see the screen can read them.";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const noSubscribe = () => () => undefined;
const originProblem = () => {
    const check = checkDisplayServer(window.location.origin);
    return check.ok ? null : check.error;
};

function failureText(failure: ProvisionFailure | null, ssid: string, detail: string | null): string {
    switch (failure) {
        case "wrong_password":
            return `"${ssid}" rejected the Wi-Fi password. Check it and try again.`;
        case "no_network":
            return `The display can't see "${ssid}". It only uses 2.4 GHz Wi-Fi: check that the network has a 2.4 GHz band and that the display is in range.`;
        case "wifi_timeout":
            return `The display couldn't join "${ssid}" in time. Check the password and that the router is in range.`;
        case "token_rejected":
            return "The server rejected the display's key. Try again to create a new one.";
        case "rejected_config":
            return `The display refused the settings (${detail ?? "invalid"}).`;
        default:
            return "Setup did not finish.";
    }
}

function phaseText(p: ProvisionProgress, usbLost: boolean): string {
    switch (p.phase) {
        case "sending": return "Creating the display key and sending the settings";
        case "restarting": return "Settings saved. The display is restarting";
        case "joining_wifi": return usbLost ? "Waiting for the display to come online" : "Joining Wi-Fi";
        case "wifi_connected": return p.lastFetchStatus && p.lastFetchStatus !== 200 ? `Wi-Fi connected, server answered ${p.lastFetchStatus}. Retrying` : "Wi-Fi connected. Contacting Emperor Claw";
        case "live": return "Your display is live";
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

    const [displayName, setDisplayName] = useState("Desk display");
    const [privateChats, setPrivateChats] = useState(false);

    const [progress, setProgress] = useState<ProvisionProgress>(initialProvisionProgress);
    const [usbLost, setUsbLost] = useState(false);
    const [timedOut, setTimedOut] = useState(false);

    const sessionRef = useRef<DisplaySerialSession | null>(null);
    const portRef = useRef<SerialPort | null>(null);
    // The minted display key lives only in memory, only until the board confirms it.
    const mintedRef = useRef<{ id: string; secret: string; includePrivateChats: boolean } | null>(null);
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
    const displayTokens = tokens.filter((t) => t.scope === "read_only");

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
        setBusy("Connecting to the display");
        try {
            await sessionRef.current?.close();
            const session = await DisplaySerialSession.open(port);
            attachSession(session);
            const [, version] = await Promise.all([loadManifest().catch((e: Error) => { setError(e.message); return null; }), session.queryVersion()]);
            setBoardVersion(version);
            setStep("firmware");
        } catch (e) {
            setError(e instanceof Error && /open/i.test(e.message)
                ? "Couldn't open the port. Close any other app using the display (a serial monitor, PlatformIO) and try again."
                : `Couldn't connect: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBusy(null);
        }
    };

    // ------------------------------------------------------------ step 2: firmware

    const installFirmware = async () => {
        if (!manifest || !portRef.current) return;
        setError(null);
        setBusy("Installing firmware");
        setFlash({ percent: 0, label: "Downloading firmware" });
        try {
            const { downloadFirmwareImages, flashDisplayFirmware } = await import("@/lib/throne-display/flasher");
            const images = await downloadFirmwareImages(manifest);
            const port = portRef.current;
            await sessionRef.current?.close();
            sessionRef.current = null;
            setConnected(false);
            await flashDisplayFirmware(port, manifest, images, setFlash);
            setFlash({ percent: 100, label: "Waiting for the display to restart" });
            await sleep(1500);
            const session = await ensureSession(20000);
            if (!session) {
                setError("Firmware installed, but the display did not reconnect. Unplug it, plug it back in and press Reconnect.");
                return;
            }
            const version = await session.queryVersion(6000);
            setBoardVersion(version);
            if (!isFirmwareCurrent(version, manifest.version)) {
                setError(`The display restarted but reports firmware ${version ?? "nothing"}. Try installing again.`);
                return;
            }
            toast.success(`Firmware ${manifest.version} installed`);
            goToWifi();
        } catch (e) {
            setError(`Install failed: ${e instanceof Error ? e.message : String(e)}. If it keeps failing, hold BOOT while plugging the display in and try again.`);
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
            setError(`Couldn't reconnect: ${e instanceof Error ? e.message : String(e)}`);
        }
    };

    // ------------------------------------------------------------ step 3: Wi-Fi

    const scan = useCallback(async () => {
        setError(null);
        setScanning(true);
        try {
            const session = await ensureSession();
            if (!session) {
                setError("The display is not connected. Press Reconnect.");
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
            setError("The display couldn't scan for Wi-Fi networks. Try again, or type the network name under Other.");
        } catch (e) {
            setError(`Scan failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setScanning(false);
        }
    }, [ensureSession]);

    const goToWifi = () => {
        setStep("wifi");
        if (networks.length === 0 && !scanning) void scan();
    };

    const wifiValid = () => {
        const probe = encodeProvisionCommand({ ssid, password: effectivePassword, server: "https://x.example", token: "probe" });
        if (!probe.ok && (probe.field === "ssid" || probe.field === "password")) return probe.error;
        if (selectedNetwork?.secure && !password) return "This network needs a password.";
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
            if (!session) throw new Error("The display is not connected. Press Reconnect, then try again.");

            // A key from an earlier attempt is reused unless its options changed.
            if (mintedRef.current && mintedRef.current.includePrivateChats !== privateChats) revokeUnused();
            if (!mintedRef.current) {
                const res = await fetch("/api/settings/tokens", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: displayName.trim() || "Desk display", scope: "read_only", ...(privateChats ? { includePrivateChats: true } : {}) }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || "Couldn't create the display key.");
                mintedRef.current = { id: data.token.id, secret: data.secret, includePrivateChats: privateChats };
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
            if (ok === null && state.phase === "sending") throw new Error("The display did not answer. Check the cable and try again.");

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
                    const seen = (data?.tokens as DisplayToken[] | undefined)?.find((t) => t.id === minted.id);
                    if (seen?.lastUsedAt) apply({ ...state, phase: "live", failure: null });
                }
                await sleep(400);
            }
            off();
            if (run !== runRef.current) return;
            if (state.phase === "live") {
                mintedRef.current = null; // the board owns the key now
                toast.success("Your display is live");
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

    const stepIndex = STEPS.findIndex((s) => s.id === step);
    const failed = progress.phase === "failed";
    const live = progress.phase === "live";

    return (
        <section className="grid gap-4 sm:gap-6 grid-cols-1 lg:grid-cols-[minmax(0,1.3fr)_minmax(300px,1fr)]">
            <div className="emperor-panel rounded-2xl sm:rounded-3xl p-4 sm:p-6">
                <h2 className="flex items-center text-lg font-semibold text-zinc-100">
                    <IconDeviceDesktop className="mr-2 h-5 w-5 text-cyan-300" /> Set up a display
                </h2>
                <p className="mt-2 text-sm leading-6 text-zinc-400">
                    The Throne Display is a small round desk screen (ESP32-C3, 240x240) that shows your agents working around the Emperor&apos;s throne, their health and the latest messages, live. Plug it into this computer with a USB cable and this page installs the firmware, connects it to Wi-Fi and gives it its own read-only key. You never copy a token.
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
                        <span>Requires Chrome or Edge on a computer (Web Serial). Phones, Safari and Firefox can&apos;t talk to USB devices; you can still set the display up from its own Wi-Fi setup page (hold the screen for 5 seconds).</span>
                    </div>
                )}

                <ol className="mt-5 flex flex-wrap gap-1.5" aria-label="Setup steps">
                    {STEPS.map((s, i) => (
                        <li
                            key={s.id}
                            aria-current={s.id === step ? "step" : undefined}
                            className={cn(
                                "rounded-full border px-3 py-1 text-xs font-medium",
                                s.id === step ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100" : i < stepIndex ? "border-emerald-500/25 text-emerald-700 dark:text-emerald-200/80" : "border-border text-zinc-500",
                            )}
                        >
                            {i + 1}. {s.label}
                        </li>
                    ))}
                </ol>

                <div className="mt-5 space-y-4">
                    {step === "connect" && (
                        <div className="space-y-3">
                            <p className="text-sm text-zinc-400">Plug the display into this computer, then pick it in the browser&apos;s list (it shows up as a USB JTAG/serial device).</p>
                            <Button onClick={connect} disabled={!supported || !!serverProblem || !!busy}>
                                {busy ? <IconLoader2 className="h-4 w-4 animate-spin" /> : <IconUsb className="h-4 w-4" />} {busy ?? "Connect display"}
                            </Button>
                        </div>
                    )}

                    {step === "firmware" && (
                        <div className="space-y-3">
                            <div className="rounded-xl border border-border bg-zinc-950/60 p-4 text-sm">
                                <div className="flex items-center gap-2 text-zinc-200"><IconCpu className="h-4 w-4 text-cyan-300" /> Display firmware</div>
                                <p className="mt-2 text-zinc-400">
                                    On the display: <span className="font-mono text-zinc-200">{boardVersion === "unknown" ? "an older version" : boardVersion ?? "not detected"}</span>
                                    {" · "}Latest: <span className="font-mono text-zinc-200">{manifest?.version ?? "unavailable"}</span>
                                </p>
                            </div>
                            {flash && (
                                <div>
                                    <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]" role="progressbar" aria-valuenow={flash.percent} aria-valuemin={0} aria-valuemax={100}>
                                        <div className="h-full rounded-full bg-cyan-400 transition-[width] duration-300" style={{ width: `${flash.percent}%` }} />
                                    </div>
                                    <p className="mt-2 text-xs text-zinc-500">{flash.label} · {flash.percent}%</p>
                                </div>
                            )}
                            <div className="flex flex-wrap gap-2">
                                {manifest && isFirmwareCurrent(boardVersion, manifest.version) ? (
                                    <>
                                        <Button onClick={goToWifi} disabled={!!busy}>Skip — already installed</Button>
                                        <Button variant="outline" onClick={installFirmware} disabled={!!busy || !connected}>Reinstall</Button>
                                    </>
                                ) : (
                                    <Button onClick={installFirmware} disabled={!!busy || !manifest || !portRef.current}>
                                        {busy ? <IconLoader2 className="h-4 w-4 animate-spin" /> : <IconCpu className="h-4 w-4" />} {busy ?? `Install firmware ${manifest?.version ?? ""}`}
                                    </Button>
                                )}
                                {!connected && !busy && <Button variant="outline" onClick={reconnect}><IconUsb className="h-4 w-4" /> Reconnect</Button>}
                            </div>
                            <p className="text-xs leading-5 text-zinc-500">Installing keeps the display&apos;s saved settings. It takes about a minute; don&apos;t unplug the cable.</p>
                        </div>
                    )}

                    {step === "wifi" && (
                        <div className="space-y-3">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-medium text-zinc-300">Wi-Fi network</span>
                                <Button size="sm" variant="ghost" onClick={() => void scan()} disabled={scanning}>
                                    <IconRefresh className={cn("h-4 w-4", scanning && "animate-spin")} /> {scanning ? "Scanning" : "Scan again"}
                                </Button>
                            </div>
                            <div className="max-h-72 divide-y divide-white/10 overflow-y-auto rounded-xl border border-border" role="radiogroup" aria-label="Wi-Fi networks">
                                {networks.length === 0 && (
                                    <div className="p-4 text-sm text-zinc-500">{scanning ? "The display is looking for networks..." : "No networks found."}</div>
                                )}
                                {networks.map((n) => (
                                    <label key={n.ssid} className={cn("flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm", ssidChoice === n.ssid ? "bg-cyan-400/[0.07]" : "hover:bg-white/[0.03]")}>
                                        <input type="radio" name="display-ssid" className="accent-cyan-400" checked={ssidChoice === n.ssid} onChange={() => setSsidChoice(n.ssid)} />
                                        <span className="min-w-0 flex-1 truncate text-zinc-100">{n.ssid}</span>
                                        {n.secure && <IconLock className="h-3.5 w-3.5 text-zinc-500" aria-label="Password protected" />}
                                        <SignalBars rssi={n.rssi} />
                                    </label>
                                ))}
                                <label className={cn("flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm", ssidChoice === OTHER ? "bg-cyan-400/[0.07]" : "hover:bg-white/[0.03]")}>
                                    <input type="radio" name="display-ssid" className="accent-cyan-400" checked={ssidChoice === OTHER} onChange={() => setSsidChoice(OTHER)} />
                                    <span className="text-zinc-300">Other network (hidden, or not listed)</span>
                                </label>
                            </div>
                            {ssidChoice === OTHER && (
                                <Input placeholder="Network name" value={otherSsid} onChange={(e) => setOtherSsid(e.target.value)} aria-label="Network name" autoComplete="off" />
                            )}
                            <p className="text-xs leading-5 text-zinc-500">
                                <IconWifi className="mr-1 inline h-3.5 w-3.5" />
                                The list comes from the display itself, so it only shows 2.4 GHz networks. The display can&apos;t use 5 GHz Wi-Fi; if your router has separate 2.4 and 5 GHz names, pick the 2.4 GHz one.
                            </p>
                            {(ssidChoice === OTHER || selectedNetwork?.secure !== false) && (
                                <label className="block space-y-2">
                                    <span className="text-sm font-medium text-zinc-300">Wi-Fi password</span>
                                    <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" placeholder={ssidChoice === OTHER ? "Leave empty for an open network" : ""} />
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
                                    Continue
                                </Button>
                                {!connected && <Button variant="outline" onClick={reconnect}><IconUsb className="h-4 w-4" /> Reconnect</Button>}
                            </div>
                        </div>
                    )}

                    {step === "options" && (
                        <div className="space-y-4">
                            <label className="block space-y-2">
                                <span className="text-sm font-medium text-zinc-300">Display name</span>
                                <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={80} />
                                <span className="block text-xs text-zinc-500">Shown in the list of displays below, so you can revoke the right one later.</span>
                            </label>
                            <label className="flex items-start gap-3 rounded-xl border border-border bg-white/[0.02] p-3">
                                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-cyan-400" checked={privateChats} onChange={(e) => setPrivateChats(e.target.checked)} />
                                <span className="space-y-1">
                                    <span className="block text-sm font-medium text-zinc-300">Include my private chats</span>
                                    <span className="block text-xs leading-5 text-zinc-500">{PRIVATE_CHATS_HELP}</span>
                                </span>
                            </label>
                            <div className="flex flex-wrap gap-2">
                                <Button variant="outline" onClick={() => setStep("wifi")}>Back</Button>
                                <Button onClick={() => void provision()} disabled={!displayName.trim() || !!serverProblem}>Finish setup</Button>
                            </div>
                        </div>
                    )}

                    {step === "finish" && (
                        <div className="space-y-4">
                            {live ? (
                                <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-4">
                                    <div className="flex items-center gap-2 font-medium text-emerald-800 dark:text-emerald-100"><IconCircleCheck className="h-5 w-5" /> Your display is live</div>
                                    <p className="mt-1 text-sm text-emerald-700 dark:text-emerald-100/75">It is connected to &quot;{ssid}&quot; and reading {typeof window !== "undefined" ? window.location.host : "this server"}. You can unplug it from the computer and power it from any USB charger.</p>
                                </div>
                            ) : failed || error || timedOut ? (
                                <div className="rounded-2xl border border-red-500/25 bg-red-500/[0.07] p-4">
                                    <div className="flex items-center gap-2 font-medium text-red-700 dark:text-red-100"><IconAlertTriangle className="h-5 w-5" /> Setup didn&apos;t finish</div>
                                    <p className="mt-1 text-sm text-red-700 dark:text-red-100/80">
                                        {error ?? (timedOut
                                            ? usbLost
                                                ? "The display restarted and the USB connection did not come back, and it hasn't reached the server yet. Look at the screen: a green dot near the top right means it is live; \"Joining Wi-Fi\" or a red dot means it could not connect."
                                                : `The display hasn't reached the server yet. Check the Wi-Fi password and that ${typeof window !== "undefined" ? window.location.host : "this server"} is reachable from that network.`
                                            : failureText(progress.failure, ssid, progress.detail))}
                                    </p>
                                </div>
                            ) : (
                                <div className="flex items-center gap-3 rounded-xl border border-border bg-zinc-950/60 p-4 text-sm text-zinc-300">
                                    <IconLoader2 className="h-4 w-4 animate-spin text-cyan-300" /> {phaseText(progress, usbLost)}...
                                </div>
                            )}
                            {!live && (failed || error || timedOut) && (
                                <div className="flex flex-wrap gap-2">
                                    {progress.failure !== "rejected_config" && <Button onClick={() => void provision()}>Try again</Button>}
                                    <Button variant="outline" onClick={startOver}>Change Wi-Fi settings</Button>
                                    {!connected && <Button variant="outline" onClick={reconnect}><IconUsb className="h-4 w-4" /> Reconnect</Button>}
                                </div>
                            )}
                            {live && (
                                <Button variant="outline" onClick={() => { setStep("connect"); setNetworks([]); setPassword(""); setProgress(initialProvisionProgress); }}>Set up another display</Button>
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

            <div className="overflow-hidden rounded-2xl sm:rounded-3xl border border-border bg-zinc-950/70 self-start">
                <div className="border-b border-border p-4 sm:p-5">
                    <h2 className="text-lg font-semibold text-zinc-100">Your displays</h2>
                    <p className="mt-1 text-sm text-zinc-500">Each display has its own read-only key. Revoke it when a display leaves your desk.</p>
                </div>
                <div className="divide-y divide-white/10">
                    {displayTokens.length === 0 ? (
                        <div className="p-8 text-center text-sm text-zinc-500">No displays yet.</div>
                    ) : (
                        displayTokens.map((token) => (
                            <div key={token.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                                <div className="min-w-0">
                                    <h3 className="font-medium text-zinc-100">{token.name}</h3>
                                    <p className="mt-1 text-xs text-zinc-500">
                                        Created {new Date(token.createdAt).toLocaleDateString()} · Last used {token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : "never"}
                                    </p>
                                    <p className="mt-1 text-xs text-zinc-500">Private chats: {token.includePrivateChats ? "on" : "off"}</p>
                                </div>
                                <Button variant="destructive" size="sm" onClick={() => onRevoke(token.id)} disabled={revokingTokenId === token.id}>
                                    <IconTrash className="h-4 w-4" /> {revokingTokenId === token.id ? "Revoking..." : confirmingRevokeId === token.id ? "Click again to confirm" : "Revoke"}
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
    const bars = signalBars(rssi);
    return (
        <span className="flex items-end gap-0.5" aria-label={`Signal ${bars} of 4`} title={`${rssi} dBm`}>
            {[1, 2, 3, 4].map((b) => (
                <span key={b} className={cn("w-1 rounded-sm", b <= bars ? "bg-cyan-300" : "bg-white/15")} style={{ height: `${b * 3 + 2}px` }} />
            ))}
        </span>
    );
}
