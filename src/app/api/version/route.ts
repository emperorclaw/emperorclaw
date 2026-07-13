import { NextResponse } from "next/server";

const pkg = require("../../../../package.json");

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
            repo: "josezuma/emperorclaw",
        },
        { status: 200 },
    );
}
