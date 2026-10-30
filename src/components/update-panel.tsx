"use client";

import { useState, useEffect } from "react";
import { IconRefresh, IconLoader2, IconCircleCheck, IconAlertTriangle } from "@tabler/icons-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

type VersionInfo = {
    current: string;
    latest: string;
    updateAvailable: boolean;
    changelog: string | null;
    mode?: "docker" | "bare-metal";
    error?: string;
};

type UpdateStep = {
    step: string;
    status: "running" | "ok" | "error";
    output: string;
};

/** The runtime's name: never translated. */
const DOCKER = "Docker";
const UPDATE_STEPS = new Set(["git-fetch", "npm-install", "db-migrate", "npm-build", "copy-static", "pm2-restart", "find-container", "inspect-container", "pull-image", "create-container", "stop-old", "start-new", "docker-socket"]);

export function UpdatePanel() {
    const t = useTranslations("updatePanel");
    const [version, setVersion] = useState<VersionInfo | null>(null);
    const [checking, setChecking] = useState(false);
    const [updating, setUpdating] = useState(false);
    const [steps, setSteps] = useState<UpdateStep[]>([]);
    const [error, setError] = useState<string | null>(null);

    const checkVersion = async () => {
        setChecking(true);
        setError(null);
        try {
            const res = await fetch("/api/ops/update");
            const data = await res.json();
            setVersion(data);
        } catch {
            setError(t("checkFailed"));
        } finally {
            setChecking(false);
        }
    };

    useEffect(() => {
        checkVersion();
    }, []);

    const handleUpdate = async () => {
        if (!confirm(t("confirm", { current: version?.current ?? "", latest: version?.latest ?? "" }))) return;

        setUpdating(true);
        setSteps([]);
        setError(null);

        try {
            const res = await fetch("/api/ops/update", { method: "POST" });
            const data = await res.json();

            if (data.success) {
                setSteps(data.steps || []);
                // Reload version after update
                setTimeout(() => checkVersion(), 3000);
            } else {
                setSteps(data.steps || []);
                setError(t("failed"));
            }
        } catch {
            setError(t("requestFailed"));
            setTimeout(() => checkVersion(), 5000);
        } finally {
            setUpdating(false);
        }
    };

    const stepLabel = (step: string) => (UPDATE_STEPS.has(step) ? t(`steps.${step as "git-fetch"}`) : step);

    const isDocker = version?.mode === "docker";

    return (
        <div className="rounded-xl border border-border bg-card p-5 force-dark">
            <div className="flex items-center justify-between mb-3">
                <div>
                    <h3 className="text-sm font-semibold text-foreground">{t("title")}</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">
                        {version
                            ? version.updateAvailable
                                ? t("available", { current: version.current, latest: version.latest })
                                : t("upToDate", { current: version.current })
                            : t("checking")}
                        {isDocker && (
                            <span className="text-zinc-600 ml-1">{`· ${DOCKER}`}</span>
                        )}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={checkVersion}
                        disabled={checking || updating}
                        className="h-7 text-xs border-zinc-700 text-zinc-400 hover:text-zinc-200"
                    >
                        <IconRefresh className={`h-3 w-3 ${checking ? "animate-spin" : ""}`} />
                        {t("check")}
                    </Button>
                    {version?.updateAvailable && (
                        <Button
                            size="sm"
                            onClick={handleUpdate}
                            disabled={updating}
                            className="h-7 text-xs bg-emerald-600 hover:bg-emerald-500 text-white"
                        >
                            {updating ? (
                                <IconLoader2 className="h-3 w-3 animate-spin" />
                            ) : (
                                t("update")
                            )}
                        </Button>
                    )}
                </div>
            </div>

            {/* Changelog */}
            {version?.changelog && (
                <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2 max-h-32 overflow-y-auto">
                    <pre className="text-[10px] text-zinc-400 font-mono whitespace-pre-wrap">{version.changelog}</pre>
                </div>
            )}

            {/* Update steps */}
            {steps.length > 0 && (
                <div className="space-y-1">
                    {steps.map((s) => (
                        <div key={s.step} className="flex items-center gap-2 text-xs">
                            {s.status === "running" && <IconLoader2 className="h-3 w-3 text-cyan-400 animate-spin" />}
                            {s.status === "ok" && <IconCircleCheck className="h-3 w-3 text-emerald-400" />}
                            {s.status === "error" && <IconAlertTriangle className="h-3 w-3 text-rose-400" />}
                            <span className={s.status === "error" ? "text-rose-400" : "text-zinc-400"}>
                                {stepLabel(s.step)}
                            </span>
                            {s.output && s.status === "error" && (
                                <span className="text-[10px] text-rose-500 truncate max-w-[200px]">{s.output.slice(0, 80)}</span>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {error && (
                <p className="text-xs text-rose-400 mt-2">{error}</p>
            )}
        </div>
    );
}
