"use client";
import { useCallback, useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import { useFormatter, useTranslations } from "next-intl";
import { IconDevices, IconHistory, IconLock, IconLoader2 } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from "@/lib/password-policy";

type BrowserSession = { id: string; current: boolean; userAgent: string | null; createdAt: string; lastSeenAt: string; expiresAt: string };
type SecurityEvent = { id: string; event: string; createdAt: string };
const panel = "emperor-panel max-w-lg rounded-2xl p-4 sm:p-6";
const input = "mt-1 min-h-11 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const button = "inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
const quiet = "min-h-11 cursor-pointer rounded-xl border border-border px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
function deviceName(agent: string | null) {
    if (!agent) return null;
    const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : null;
    const os = /Android/.test(agent) ? "Android" : /iPhone|iPad/.test(agent) ? "iOS" : /Windows/.test(agent) ? "Windows" : /Macintosh|Mac OS/.test(agent) ? "macOS" : /Linux/.test(agent) ? "Linux" : null;
    return [browser, os].filter(Boolean).join(" · ") || null;
}

export function AccountSecurity() {
    const t = useTranslations("account");
    const format = useFormatter();
    const [rows, setRows] = useState<BrowserSession[]>([]);
    const [events, setEvents] = useState<SecurityEvent[]>([]);
    const [mfaEnabled, setMfaEnabled] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const [password, setPassword] = useState("");
    const [nextPassword, setNextPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [target, setTarget] = useState<BrowserSession | "others" | null>(null);
    const [revokePassword, setRevokePassword] = useState("");
    const [revokeCode, setRevokeCode] = useState("");
    const [revokeError, setRevokeError] = useState("");
    const load = useCallback(async () => {
        setLoadError(false);
        try {
            const [sessionRes, historyRes] = await Promise.all([fetch("/api/user/sessions", { cache: "no-store" }), fetch("/api/user/security", { cache: "no-store" })]);
            if (!sessionRes.ok || !historyRes.ok) throw new Error();
            const [sessionData, historyData] = await Promise.all([sessionRes.json(), historyRes.json()]);
            setRows(sessionData.sessions); setEvents(historyData.events); setMfaEnabled(historyData.mfaEnabled); setLoaded(true);
        } catch { setLoadError(true); }
    }, []);
    useEffect(() => { void load(); }, [load]);
    useEffect(() => {
        const refresh = () => { void load(); };
        window.addEventListener("account-security-updated", refresh);
        return () => window.removeEventListener("account-security-updated", refresh);
    }, [load]);
    const errors: Record<string, string> = {
        INVALID_CREDENTIALS: t("errors.INVALID_CREDENTIALS"), MFA_REQUIRED: t("errors.MFA_REQUIRED"), MFA_INVALID: t("errors.MFA_INVALID"), SESSION_EXPIRED: t("errors.SESSION_EXPIRED"), PASSWORD_UNCHANGED: t("errors.PASSWORD_UNCHANGED"), INVALID_PASSWORD_REQUEST: t("errors.INVALID_PASSWORD_REQUEST"), RATE_LIMITED: t("errors.RATE_LIMITED"), SESSION_NOT_FOUND: t("errors.SESSION_NOT_FOUND"), INVALID_REQUEST: t("errors.INVALID_REQUEST"), INVALID_ORIGIN: t("errors.INVALID_ORIGIN"),
    };
    const eventLabels: Record<string, string> = { signed_in: t("events.signed_in"), signed_out: t("events.signed_out"), password_changed: t("events.password_changed"), password_reset: t("events.password_reset"), sessions_revoked: t("events.sessions_revoked"), mfa_enabled: t("events.mfa_enabled"), mfa_disabled: t("events.mfa_disabled"), recovery_codes_regenerated: t("events.recovery_codes_regenerated") };
    const message = (data: { code?: string }) => errors[data.code || ""] || t("errors.REQUEST_FAILED");
    const changePassword = async (event: React.FormEvent) => {
        event.preventDefault(); setError("");
        if (nextPassword !== confirm) { setError(t("passwordMismatch")); return; }
        setBusy(true);
        try {
            const res = await fetch("/api/user/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: password, newPassword: nextPassword, code }) });
            const data = await res.json();
            if (!res.ok) { setError(message(data)); return; }
            setPassword(""); setNextPassword(""); setConfirm(""); setCode("");
            await signOut({ callbackUrl: "/login?passwordChanged=1" });
        } catch { setError(t("errors.REQUEST_FAILED")); }
        finally { setBusy(false); }
    };
    const revoke = async (event: React.FormEvent) => {
        event.preventDefault(); if (!target) return;
        setBusy(true); setRevokeError("");
        try {
            const res = await fetch("/api/user/sessions", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(target === "others" ? { others: true } : { sessionId: target.id }), password: revokePassword, code: revokeCode }) });
            const data = await res.json();
            if (!res.ok) { setRevokeError(message(data)); return; }
            setTarget(null); setRevokePassword(""); setRevokeCode("");
            if (data.signedOut) await signOut({ callbackUrl: "/login" });
            else await load();
        } catch { setRevokeError(t("errors.REQUEST_FAILED")); }
        finally { setBusy(false); }
    };
    const when = (date: string) => format.dateTime(new Date(date), { dateStyle: "medium", timeStyle: "short" });
    return <>
        <section className={panel}>
            <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold"><IconLock className="h-5 w-5 text-primary" aria-hidden />{t("passwordTitle")}</h2>
            <p className="mb-5 text-sm text-muted-foreground">{t("passwordDescription")}</p>
            <form onSubmit={changePassword} className="space-y-4">
                <label className="block text-sm font-medium">{t("currentPassword")}<input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={input} /></label>
                <label className="block text-sm font-medium">{t("newPassword")}<input type="password" required minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} autoComplete="new-password" value={nextPassword} onChange={(e) => setNextPassword(e.target.value)} className={input} aria-describedby="password-policy" /></label>
                <p id="password-policy" className="text-xs text-muted-foreground">{t("passwordPolicy")}</p>
                <label className="block text-sm font-medium">{t("confirmPassword")}<input type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={input} /></label>
                {mfaEnabled && <label className="block text-sm font-medium">{t("mfaCode")}<input required autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} className={input} /></label>}
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <button disabled={busy || !loaded || loadError} className={button}>{busy && <IconLoader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}{t("changePassword")}</button>
            </form>
        </section>
        <section className={panel}>
            <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold"><IconDevices className="h-5 w-5 text-primary" aria-hidden />{t("sessionsTitle")}</h2>
            <p className="mb-4 text-sm text-muted-foreground">{t("sessionsDescription")}</p>
            {loadError ? <p role="alert" className="text-sm text-destructive">{t("loadFailed")} <button type="button" onClick={() => void load()} className="min-h-11 underline">{t("retry")}</button></p> : !loaded ? <p role="status" className="text-sm text-muted-foreground">{t("loading")}</p> : <>
                <ul className="divide-y divide-border">
                    {rows.map((row) => <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 py-4">
                        <div className="min-w-0"><p className="text-sm font-medium">{deviceName(row.userAgent) || t("unknownDevice")}</p>
                            {row.current && <span className="mt-1 inline-flex rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{t("currentSession")}</span>}
                            <p className="mt-2 text-xs text-muted-foreground">{t("lastActive", { date: when(row.lastSeenAt) })}</p>
                            <p className="mt-1 text-xs text-muted-foreground">{t("signedInAt", { date: when(row.createdAt) })}</p>
                        </div>
                        {!row.current && <button disabled={busy} type="button" className={quiet} onClick={() => { setTarget(row); setRevokeError(""); }}>{t("revokeSession")}</button>}
                    </li>)}
                </ul>
                <button disabled={busy || !rows.some((row) => !row.current)} type="button" onClick={() => { setTarget("others"); setRevokeError(""); }} className={quiet}>{t("revokeOthers")}</button>
            </>}
        </section>
        <section className={panel}>
            <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold"><IconHistory className="h-5 w-5 text-primary" aria-hidden />{t("historyTitle")}</h2>
            <p className="mb-4 text-sm text-muted-foreground">{t("historyDescription")}</p>
            {loaded && !events.length && <p className="text-sm text-muted-foreground">{t("noHistory")}</p>}
            <ul className="divide-y divide-border">{events.map((event) => <li key={event.id} className="py-3"><p className="text-sm">{eventLabels[event.event] || t("eventRecorded")}</p><time dateTime={event.createdAt} className="mt-1 block text-xs text-muted-foreground">{when(event.createdAt)}</time></li>)}</ul>
        </section>
        <Dialog open={target !== null} onOpenChange={(open) => { if (!open && !busy) { setTarget(null); setRevokePassword(""); setRevokeCode(""); } }}>
            <DialogContent className="max-h-[90dvh] overflow-y-auto">
                <DialogTitle>{t(target === "others" ? "revokeOthers" : "revokeSession")}</DialogTitle>
                <DialogDescription>{t("revokeDescription")}</DialogDescription>
                <form onSubmit={revoke} className="space-y-4">
                    <label className="block text-sm font-medium">{t("currentPassword")}<input autoFocus type="password" autoComplete="current-password" required value={revokePassword} onChange={(e) => setRevokePassword(e.target.value)} className={input} /></label>
                    {mfaEnabled && <label className="block text-sm font-medium">{t("mfaCode")}<input autoComplete="one-time-code" required value={revokeCode} onChange={(e) => setRevokeCode(e.target.value)} className={input} /></label>}
                    {revokeError && <p role="alert" className="text-sm text-destructive">{revokeError}</p>}
                    <div className="flex flex-wrap gap-3"><button type="button" disabled={busy} className={quiet} onClick={() => { setTarget(null); setRevokePassword(""); setRevokeCode(""); }}>{t("cancel")}</button><button disabled={busy} className={button}>{busy ? t("working") : t("confirmRevoke")}</button></div>
                </form>
            </DialogContent>
        </Dialog>
    </>;
}
