import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { getCompanyId } from "@/lib/auth";
import { cookies } from "next/headers";
import fs from "fs";

export const dynamic = "force-dynamic";
const execAsync = promisify(exec);

const PROJECT_DIR = "/var/www/emperorclaw";
const GITHUB_RELEASES_API = "https://api.github.com/repos/emperorclaw/emperorclaw/releases/latest";
const WATCHTOWER_API = "http://watchtower:8080/v1/update";

function isDocker(): boolean {
    try {
        return fs.existsSync("/.dockerenv");
    } catch {
        return false;
    }
}

type UpdateStep = {
    step: string;
    status: "running" | "ok" | "error";
    output: string;
};

export async function POST() {
    const cookieStore = await cookies();
    const sessionToken = cookieStore.get("__Secure-next-auth.session-token")
        || cookieStore.get("next-auth.session-token");

    if (!sessionToken) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const companyId = await getCompanyId();
    if (!companyId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const docker = isDocker();

    // ---- Docker mode: trigger Watchtower ----
    if (docker) {
        try {
            const res = await fetch(WATCHTOWER_API, {
                method: "POST",
                signal: AbortSignal.timeout(15000),
            });

            if (!res.ok) {
                const text = await res.text().catch(() => "");
                return NextResponse.json({
                    success: false,
                    mode: "docker",
                    steps: [{ step: "watchtower-trigger", status: "error", output: text || `HTTP ${res.status}` }],
                }, { status: 502 });
            }

            return NextResponse.json({
                success: true,
                mode: "docker",
                steps: [{ step: "watchtower-trigger", status: "ok", output: "Watchtower is checking for updates. The container will restart if a new image is found." }],
            });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            return NextResponse.json({
                success: false,
                mode: "docker",
                steps: [{ step: "watchtower-trigger", status: "error", output: `Watchtower unreachable: ${msg}. Ensure Watchtower is running in docker-compose.` }],
            }, { status: 502 });
        }
    }

    // ---- Bare-metal mode: git pull + build + restart ----
    const steps: UpdateStep[] = [];

    const run = async (step: string, cmd: string): Promise<UpdateStep> => {
        const entry: UpdateStep = { step, status: "running", output: "" };
        steps.push(entry);
        try {
            const { stdout, stderr } = await execAsync(cmd, {
                cwd: PROJECT_DIR,
                timeout: 180_000,
                env: { ...process.env, NODE_ENV: "production" },
            });
            entry.output = (stdout + stderr).trim();
            entry.status = "ok";
        } catch (err: unknown) {
            const e = err as { stdout?: string; stderr?: string; message?: string };
            entry.output = ((e.stdout || "") + (e.stderr || "") + (e.message || "")).trim();
            entry.status = "error";
            throw err;
        }
        return entry;
    };

    try {
        await run("git-fetch", "git fetch origin main && git reset --hard origin/main");
        await run("npm-install", "npm install");
        await run("db-migrate", "npx drizzle-kit migrate");
        await run("npm-build", "npm run build");
        await run("copy-static", "cp -r .next/static .next/standalone/.next/static && cp -r public .next/standalone/public");
        await run("pm2-restart", "pm2 restart emperorclaw --update-env");

        return NextResponse.json({ success: true, steps });
    } catch {
        return NextResponse.json({ success: false, steps }, { status: 500 });
    }
}

/** GET — check for available updates */
export async function GET() {
    const companyId = await getCompanyId();
    if (!companyId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const docker = isDocker();

    // ---- Docker mode: check GitHub Releases API ----
    if (docker) {
        try {
            const { stdout: currentVersion } = await execAsync(
                "node -e \"console.log(require('./package.json').version)\"",
                { timeout: 5000 },
            );
            const current = currentVersion.trim();

            const ghRes = await fetch(GITHUB_RELEASES_API, {
                headers: { Accept: "application/vnd.github+json" },
                signal: AbortSignal.timeout(10000),
            });

            if (!ghRes.ok) {
                return NextResponse.json({
                    current,
                    latest: "unknown",
                    updateAvailable: false,
                    mode: "docker",
                    error: `GitHub API returned ${ghRes.status}`,
                });
            }

            const release = await ghRes.json() as { tag_name: string; body: string };
            const latest = (release.tag_name || "").replace(/^v/, "");
            const updateAvailable = latest && current !== latest;

            return NextResponse.json({
                current,
                latest,
                updateAvailable,
                mode: "docker",
                changelog: release.body || null,
            });
        } catch (err: unknown) {
            return NextResponse.json({
                current: "unknown",
                latest: "unknown",
                updateAvailable: false,
                mode: "docker",
                error: err instanceof Error ? err.message : "Failed to check version",
            });
        }
    }

    // ---- Bare-metal mode: git-based version check ----
    try {
        const { stdout: currentVersion } = await execAsync(
            "node -e \"console.log(require('./package.json').version)\"",
            { cwd: PROJECT_DIR, timeout: 5000 },
        );

        await execAsync("git fetch origin --tags 2>&1 || true", {
            cwd: PROJECT_DIR,
            timeout: 15000,
        });

        const { stdout: tagsOut } = await execAsync(
            "git tag --sort=-creatordate | grep -E '^v[0-9]' | head -1",
            { cwd: PROJECT_DIR, timeout: 5000 },
        );
        const latestTag = tagsOut.trim();

        const current = currentVersion.trim();
        const latest = latestTag.replace(/^v/, "");

        const updateAvailable = latest && current !== latest;

        let changelog = "";
        if (updateAvailable) {
            try {
                const { stdout: log } = await execAsync(
                    `git log v${current}..${latestTag} --oneline --no-merges 2>&1 || echo ""`,
                    { cwd: PROJECT_DIR, timeout: 5000 },
                );
                changelog = log.trim();
            } catch {
                // Non-critical
            }
        }

        return NextResponse.json({
            current,
            latest,
            updateAvailable,
            changelog: changelog || null,
        });
    } catch (err: unknown) {
        return NextResponse.json({
            current: "unknown",
            latest: "unknown",
            updateAvailable: false,
            error: err instanceof Error ? err.message : "Failed to check version",
        });
    }
}
