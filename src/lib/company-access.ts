import { NextResponse } from "next/server";
import { AuthError, requireRole, type GuardContext, type Role } from "@/lib/roles";
import type { ModuleKey } from "@/lib/modules";
import { moduleGuard } from "@/lib/modules-server";

/**
 * The single human-facing access check for /api/* routes and server pages.
 *
 * - role and member scope come from the DB on every call (requireRole), not
 *   from the login-time JWT, so a demotion or scope edit applies immediately;
 * - reads need "viewer", anything that changes company data needs "member"
 *   (viewers never mutate), company administration needs "admin";
 * - `ctx.scope` is the restricted member's allow-list (lib/member-scope.ts);
 *   routes filter/deny agents, customers and projects through it.
 */
export type CompanyAccess = GuardContext;

export const READ_ROLE: Role = "viewer";
export const WRITE_ROLE: Role = "member";
export const ADMIN_ROLE: Role = "admin";

export async function requireCompanyAccess(minRole: Role = READ_ROLE): Promise<CompanyAccess> {
    return requireRole(minRole)();
}

/** AuthError -> its JSON response; null for anything else. */
export function accessErrorResponse(error: unknown): NextResponse | null {
    if (error instanceof AuthError) {
        return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    return null;
}

/**
 * Route convenience: `const access = await companyRouteAccess("member"); if (access.response) return access.response;`
 * Pass `{ module }` for a route that belongs to a module (lib/modules.ts): it answers 403 while the module is off.
 */
export async function companyRouteAccess(
    minRole: Role = READ_ROLE,
    options: { module?: ModuleKey } = {},
): Promise<{ ctx: CompanyAccess; response?: undefined } | { ctx?: undefined; response: NextResponse }> {
    try {
        const ctx = await requireCompanyAccess(minRole);
        const off = options.module ? await moduleGuard(ctx.companyId, options.module) : null;
        return off ? { response: off } : { ctx };
    } catch (error) {
        const response = accessErrorResponse(error);
        if (response) return { response };
        throw error;
    }
}

/** A record outside the member's scope reads as missing (never confirms it exists). */
export function outOfMemberScope(what = "Resource"): NextResponse {
    return NextResponse.json({ error: `${what} not found` }, { status: 404 });
}
