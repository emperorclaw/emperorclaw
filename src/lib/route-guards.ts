import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireRole, type Role } from "@/lib/roles";

/**
 * Higher-order wrapper for Next.js App Router route handlers.
 * Automatically validates session and checks the required role before
 * executing the handler. Redirects/returns 401 or 403 on failure.
 *
 * Usage:
 *   export const POST = withRoleApi("admin")(async (req, ctx) => { ... });
 */
export function withRoleApi(...roles: Role[]) {
    return function wrap(
        handler: (req: NextRequest, ctx: { userId: string; companyId: string; role: Role }) => Promise<NextResponse>
    ) {
        return async function (req: NextRequest): Promise<NextResponse> {
            try {
                const guard = requireRole(...roles);
                const ctx = await guard();
                return handler(req, ctx);
            } catch (err) {
                if (err instanceof AuthError) {
                    return NextResponse.json(
                        { error: err.message },
                        { status: err.statusCode }
                    );
                }
                console.error("Route guard error:", err);
                return NextResponse.json(
                    { error: "Internal Server Error" },
                    { status: 500 }
                );
            }
        };
    };
}
