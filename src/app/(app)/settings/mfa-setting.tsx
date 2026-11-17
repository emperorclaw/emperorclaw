"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

export function MfaSetting() {
    const t = useTranslations("mfa");
    const [status, setStatus] = useState<{ enabled: boolean; available: boolean } | null>(null);
    const [password, setPassword] = useState("");
    const [code, setCode] = useState("");
    const [secret, setSecret] = useState("");
    const [recovery, setRecovery] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const load = () => {
        setError("");
        fetch("/api/user/mfa", { cache: "no-store" }).then(async (res) => {
            if (!res.ok) throw new Error();
            setStatus(await res.json());
        }).catch(() => setError(t("failed")));
    };
    useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        setBusy(true); setError("");
        try {
            const res = await fetch("/api/user/mfa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: status?.enabled ? "disable" : secret ? "confirm" : "setup", password, code }) });
            const data = await res.json();
            if (!res.ok) { setError(data.error || t("failed")); return; }
            if (data.secret) setSecret(data.secret);
            else {
                setStatus((prev) => prev ? { ...prev, enabled: data.enabled } : prev);
                setSecret(""); setPassword(""); setCode("");
                setRecovery(data.recoveryCodes || []);
            }
        } catch { setError(t("failed")); }
        finally { setBusy(false); }
    };
    const input = "mt-1 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground";
    return <section className="emperor-panel max-w-lg rounded-2xl p-4 sm:p-6">
        <h2 className="mb-2 text-lg font-semibold">{t("title")}</h2>
        <p className="mb-4 text-sm text-muted-foreground">{t("description")}</p>
        {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
        {!status ? <><p role="status">{t("loading")}</p>{error && <button onClick={load}>{t("retry")}</button>}</> : <>
            <p className="mb-3 text-sm">{t(status.enabled ? "enabled" : "disabled")}</p>
            {!status.available ? <p>{t("unavailable")}</p> : recovery.length ? <div>
                <p className="mb-3 text-sm">{t("recovery")}</p>
                <pre className="overflow-x-auto rounded-xl bg-muted p-3 text-sm select-all">{recovery.join("\n")}</pre>
                <button className="mt-3 min-h-11 underline" onClick={() => setRecovery([])}>{t("done")}</button>
            </div> : <form onSubmit={submit} className="space-y-4">
                {secret && <div><p className="text-sm">{t("secret")}</p><code className="my-3 block break-all rounded-xl bg-muted p-3 select-all">{secret}</code></div>}
                <label className="block text-sm">{t("password")}<input className={input} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
                {(status.enabled || secret) && <label className="block text-sm">{t("code")}<input className={input} autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} /></label>}
                <button disabled={busy} className="min-h-11 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">{t(status.enabled ? "disable" : secret ? "confirm" : "setup")}</button>
            </form>}
        </>}
    </section>;
}
