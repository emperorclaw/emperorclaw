import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { hermesConfigDefaultsEnvValue } from "@/lib/hermes-profile-defaults";

/**
 * GET /api/mcp/runtime/profile-defaults — the Hermes profile config every
 * Emperor agent runs with, as `text/plain` `key=value` lines (one per line,
 * split on the first "="). The remote installer applies the same defaults the
 * managed Docker entrypoint applies, from this one source.
 */
export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    return new NextResponse(`${hermesConfigDefaultsEnvValue()}\n`, {
        status: 200,
        headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
        },
    });
}
