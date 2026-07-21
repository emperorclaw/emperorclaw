import { NextResponse } from "next/server";
import pkg from "@/../package.json" assert { type: "json" };

/**
 * GET /api/version
 *
 * Returns the current deployed version so the dashboard can compare against
 * the latest GitHub release and show an "update available" banner.
 *
 * Public — no auth required. Useful for health checks too.
 */
export async function GET() {
    return NextResponse.json(
        {
            version: pkg.version,
            name: pkg.name,
            // Canonical public repo. Must match the slug used by the update-check
            // routes (emperorclaw/emperorclaw); the old josezuma/emperorclaw only
            // resolves via a GitHub 301 redirect, so the banner checked the wrong repo.
            repo: "emperorclaw/emperorclaw",
        },
        { status: 200 },
    );
}
