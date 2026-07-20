import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { getCompanyId } from "@/lib/auth";
import { isSelfHosted } from "@/lib/instance";
import { db } from "@/db";
import { users, companyMembers } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";
const execAsync = promisify(exec);

const PROJECT_DIR = "/var/www/emperorclaw";

type UpdateStep = {
    step: string;
    status: "running" | "ok" | "error";
    output: string;
};

export async function POST() {
    // Auth: must be instance_admin or owner
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

    // Self-hosted only
    if (!isSelfHosted()) {
        return NextResponse.json({ error: "Updates are only available in self-hosted mode" }, { status: 403 });
    }

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
        // 1. Git pull
        await run("git-fetch", "git fetch origin main && git reset --hard origin/main");

        // 2. Install dependencies
        await run("npm-install", "npm install");

        // 3. Run database migrations
        await run("db-migrate", "npx drizzle-kit migrate");

        // 4. Build
        await run("npm-build", "npm run build");

        // 5. Restart PM2
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

    try {
        // Get current version from package.json
        const { stdout: currentVersion } = await execAsync("node -e \"console.log(require('./package.json').version)\"", {
            cwd: PROJECT_DIR,
            timeout: 5000,
        });

        // Fetch latest tag from git
        await execAsync("git fetch origin --tags 2>&1 || true", {
            cwd: PROJECT_DIR,
            timeout: 15000,
        });

        const { stdout: tagsOut } = await execAsync(
            "git tag --sort=-creatordate | grep -E '^v[0-9]' | head -1",
            { cwd: PROJECT_DIR, timeout: 5000 },
        );
        const latestTag = tagsOut.trim();

        // Parse versions
        const current = currentVersion.trim();
        const latest = latestTag.replace(/^v/, "");

        const updateAvailable = latest && current !== latest;

        // Get commits between current and latest
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
