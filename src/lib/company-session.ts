import { AuthError, requireRole, type Role } from "@/lib/roles";
import type { MemberScope } from "@/lib/member-scope";

export interface SessionCompany {
    companyId: string;
    userId: string;
    role: Role;
    /** Restricted member scope from the DB (null = unrestricted). */
    scope: MemberScope | null;
}

/**
 * Session -> company for UI routes, through the central role guard
 * (lib/roles.ts requireRole): reads need "viewer" (the default), anything that
 * changes data must ask for "member". Throws Error("Unauthorized") when there
 * is no session and Error("Forbidden: ...") when the role is too low or there
 * is no membership; routes map those to 401/403.
 */
export async function requireCompanyFromSession(minRole: Role = "viewer"): Promise<SessionCompany> {
    try {
        const ctx = await requireRole(minRole)();
        return { companyId: ctx.companyId, userId: ctx.userId, role: ctx.role, scope: ctx.scope };
    } catch (error) {
        if (error instanceof AuthError) {
            throw new Error(error.statusCode === 401 ? "Unauthorized" : `Forbidden: ${error.message}`);
        }
        throw error;
    }
}
