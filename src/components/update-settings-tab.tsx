"use client";

import { useEffect, useState } from "react";
import { IconArrowUp, IconDownload, IconExternalLink, IconRefresh, IconServer, IconTerminal2 } from "@tabler/icons-react";
import { toast } from "sonner";
import { useFormatter, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface UpdateInfo {
    currentVersion: string;
    latestVersion: string;
    isUpdateAvailable: boolean;
    changelog: string;
    publishedAt: string;
    downloadUrl: string;
    error?: string;
}

type UpdatesT = ReturnType<typeof useTranslations<"settings.updates">>;

const BACKUP_COMMAND = "pg_dump $POSTGRES_CONNECTION_STRING > backup-$(date +%Y%m%d).sql";

/** The shell steps; only the # comments are translated. */
function dockerScript(t: UpdatesT): string {
    return [
        `# 1. ${t("script.backup")}`, BACKUP_COMMAND, "",
        `# 2. ${t("script.pullRebuild")}`, "cd ~/emperorclaw", "git pull --ff-only origin main", "docker compose up -d --build", "",
        `# 3. ${t("script.verify")}`, "docker compose logs -f app",
    ].join("\n");
}

function manualScript(t: UpdatesT): string {
    return [
        `# 1. ${t("script.backup")}`, BACKUP_COMMAND, "",
        `# 2. ${t("script.pull")}`, "cd ~/emperorclaw", "git pull --ff-only origin main", "",
        `# 3. ${t("script.installRebuild")}`, "npm install", "npm run build", "",
        `# 4. ${t("script.migrate")}`, "npm run db:migrate", "",
        `# 5. ${t("script.restart")}`, "npm start",
    ].join("\n");
}

const rollbackScript = (version: string) => `git checkout v${version}\ndocker compose up -d --build`;

const BACKUP_SCRIPTS = "Linux/macOS: scripts/backup-db.sh\nWindows:     scripts/backup-db.ps1";

export function UpdateSettingsTab() {
    const t = useTranslations("settings.updates");
    const format = useFormatter();
    const [data, setData] = useState<UpdateInfo | null>(null);
    const [loading, setLoading] = useState(true);

    const fetchUpdate = async () => {
        setLoading(true);
        try {
            const res = await fetch("/api/updates/check");
            if (res.ok) {
                setData(await res.json());
            }
        } catch {
            toast.error(t("checkFailed"));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void fetchUpdate();
    }, []);

    if (loading && !data) {
        return (
            <section className="space-y-4">
                <div className="emperor-panel rounded-2xl sm:rounded-2xl p-8 text-center">
                    <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-400" />
                    <p className="mt-4 text-sm text-muted-foreground">{t("checking")}</p>
                </div>
            </section>
        );
    }

    if (!data) return null;

    const publishedDate = data.publishedAt
        ? format.dateTime(new Date(data.publishedAt), { year: "numeric", month: "long", day: "numeric" })
        : "";

    return (
        <section className="space-y-4">
            {/* Current version card */}
            <div className="emperor-panel rounded-2xl sm:rounded-2xl p-4 sm:p-6">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="flex items-center text-lg font-semibold text-foreground">
                            <IconServer className="mr-2 h-5 w-5 text-cyan-300" /> {t("instanceVersion")}
                        </h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                            {t("selfHosted")}
                        </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={fetchUpdate} disabled={loading}>
                        <IconRefresh className={cn("h-4 w-4", loading && "animate-spin")} />
                        {t("checkNow")}
                    </Button>
                </div>

                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border border-border bg-muted/30 p-4">
                        <div className="text-xs uppercase tracking-wider text-muted-foreground">{t("installed")}</div>
                        <div className="mt-1 font-mono text-2xl font-bold text-foreground">
                            v{data.currentVersion}
                        </div>
                    </div>
                    <div className={cn(
                        "rounded-xl border p-4",
                        data.isUpdateAvailable
                            ? "border-cyan-400/20 bg-cyan-400/8"
                            : "border-emerald-500/20 bg-emerald-500/8",
                    )}>
                        <div className="text-xs uppercase tracking-wider text-muted-foreground">{t("latest")}</div>
                        <div className="mt-1 font-mono text-2xl font-bold text-foreground">
                            v{data.latestVersion}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                            {data.isUpdateAvailable
                                ? t("released", { date: publishedDate })
                                : t("upToDate")}
                        </div>
                    </div>
                </div>
            </div>

            {/* Update available banner */}
            {data.isUpdateAvailable && (
                <div className="rounded-2xl sm:rounded-2xl border border-cyan-400/20 bg-cyan-400/8 p-4 sm:p-6">
                    <div className="flex items-start gap-3">
                        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-cyan-400/15">
                            <IconArrowUp className="h-5 w-5 text-cyan-300" />
                        </div>
                        <div className="min-w-0">
                            <h3 className="text-lg font-semibold text-cyan-100">
                                {t("updateAvailable", { version: data.latestVersion })}
                            </h3>
                            <p className="mt-1 text-sm text-cyan-200/70">
                                {t("releasedReview", { date: publishedDate })}
                            </p>
                            <div className="mt-4 flex flex-wrap gap-2">
                                <a
                                    href={data.downloadUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1.5 rounded-xl bg-cyan-400/15 px-4 py-2 text-sm font-semibold text-cyan-200 transition-colors hover:bg-cyan-400/25"
                                >
                                    <IconExternalLink className="h-4 w-4" />
                                    {t("viewOnGitHub")}
                                </a>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Upgrade instructions */}
            <div className="emperor-panel rounded-2xl sm:rounded-2xl p-4 sm:p-6">
                <h2 className="flex items-center text-lg font-semibold text-foreground">
                    <IconTerminal2 className="mr-2 h-5 w-5 text-cyan-300" /> {t("howToUpgrade")}
                </h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {t("migrationsNote")}
                </p>

                <div className="mt-5 space-y-4">
                    {/* Docker upgrade */}
                    <div className="rounded-xl border border-border bg-muted/30 p-4">
                        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                            <IconDownload className="h-4 w-4 text-cyan-300" />
                            {t("docker")}
                        </h3>
                        <div className="mt-3 space-y-2">
                            <div className="rounded-lg bg-background p-3">
                                <code className="block whitespace-pre-wrap font-mono text-sm text-foreground">
                                    {dockerScript(t)}
                                </code>
                            </div>
                        </div>
                    </div>

                    {/* Manual upgrade */}
                    <div className="rounded-xl border border-border bg-muted/30 p-4">
                        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                            <IconTerminal2 className="h-4 w-4 text-muted-foreground" />
                            {t("manual")}
                        </h3>
                        <div className="mt-3 space-y-2">
                            <div className="rounded-lg bg-background p-3">
                                <code className="block whitespace-pre-wrap font-mono text-sm text-foreground">
                                    {manualScript(t)}
                                </code>
                            </div>
                        </div>
                    </div>

                    {/* Backup scripts */}
                    <div className="rounded-xl border border-border bg-muted/30 p-4">
                        <h3 className="text-sm font-semibold text-foreground">{t("backupScripts")}</h3>
                        <p className="mt-1 text-sm text-muted-foreground">
                            {t("backupScriptsHint")}
                        </p>
                        <div className="mt-3 space-y-2">
                            <div className="rounded-lg bg-background p-3">
                                <code className="block whitespace-pre font-mono text-xs text-muted-foreground">
                                    {BACKUP_SCRIPTS}
                                </code>
                            </div>
                        </div>
                    </div>

                    {/* Rollback */}
                    <div className="rounded-xl border border-amber-500/20 bg-amber-500/8 p-4">
                        <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-100">
                            {t("rollback")}
                        </h3>
                        <p className="mt-1 text-sm text-amber-100/70">
                            {t("rollbackHint")}
                        </p>
                        <div className="mt-3 rounded-lg bg-background p-3">
                            <code className="block whitespace-pre-wrap font-mono text-sm text-foreground">
                                {rollbackScript(data.currentVersion)}
                            </code>
                        </div>
                    </div>
                </div>
            </div>

            {/* Changelog */}
            {data.changelog && (
                <div className="emperor-panel rounded-2xl sm:rounded-2xl p-4 sm:p-6">
                    <h2 className="flex items-center text-lg font-semibold text-foreground">
                        <IconDownload className="mr-2 h-5 w-5 text-cyan-300" /> {t("changelog", { version: data.latestVersion })}
                    </h2>
                    <div className="mt-4 max-h-[600px] overflow-y-auto rounded-xl border border-border bg-muted/30 p-4 sm:p-6">
                        <div className="prose prose-invert prose-sm max-w-none [&_h2]:text-lg [&_h2]:font-bold [&_h2]:text-cyan-200 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-foreground [&_ul]:list-disc [&_ul]:pl-4 [&_li]:text-muted-foreground [&_code]:bg-white/5 [&_code]:px-1 [&_code]:rounded [&_strong]:text-foreground">
                            {/* Render the markdown changelog safely */}
                            <ChangelogContent body={data.changelog} />
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
}

function ChangelogContent({ body }: { body: string }) {
    // Simple markdown-to-HTML for changelog (headings, lists, bold, code)
    const html = body
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        // Headings
        .replace(/^### (.+)$/gm, "<h3>$1</h3>")
        .replace(/^## (.+)$/gm, "<h2>$1</h2>")
        // Bold
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        // Inline code
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        // List items
        .replace(/^- (.+)$/gm, "<li>$1</li>")
        // Wrap consecutive <li> in <ul>
        .replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>")
        // Paragraphs (double newlines)
        .replace(/\n\n/g, "</p><p>")
        // Line breaks
        .replace(/\n/g, "<br/>");

    return (
        <div
            className="[&_h2]:text-lg [&_h2]:font-bold [&_h2]:text-cyan-200 [&_h2]:mt-6 [&_h2]:mb-2 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-foreground [&_h3]:mt-4 [&_h3]:mb-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:space-y-1 [&_li]:text-muted-foreground [&_code]:bg-white/5 [&_code]:px-1 [&_code]:rounded [&_strong]:text-foreground"
            dangerouslySetInnerHTML={{ __html: `<p>${html}</p>` }}
        />
    );
}
