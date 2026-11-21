import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, asc } from "drizzle-orm";
import { db } from "@/db";
import { companies, companyMembers, mobileAuthorizationCodes, mobileSessions, sessions, users } from "@/db/schema";
import { AuthError, type GuardContext } from "@/lib/roles";
import { getEffectiveRole, roleGte, type InstanceRole, type CompanyRole } from "@/lib/role-matrix";
import { loadScopeMemberships, normalizeMemberScope } from "@/lib/member-scope";
import { getInstanceCompany, isSelfHosted } from "@/lib/instance";
import { MOBILE_ACCESS_SECONDS, MOBILE_SESSION_SECONDS, validMobileVerifier } from "@/lib/mobile-contract";

export const mobileHash = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;
const unauthorized = () => new AuthError("Mobile session invalid or expired", 401);

export async function issueMobileCode(browserSessionId: string, userId: string, challenge: string, deviceName: string) {
    return db.transaction(async (tx) => {
        // Same account lock used by password changes, so issuance cannot outlive
        // a concurrent browser-session revocation/password reset.
        const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
        const [session] = await tx.select().from(sessions).where(and(eq(sessions.id, browserSessionId), eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())));
        if (!user || user.deletedAt || !session) throw unauthorized();
        const code = secret("emc");
        await tx.insert(mobileAuthorizationCodes).values({ codeHash: mobileHash(code), browserSessionId, challenge, deviceName, expiresAt: new Date(Date.now() + 5 * 60_000) });
        return code;
    });
}

function tokenPair() {
    const accessToken = secret("ema");
    const refreshToken = secret("emr");
    return { accessToken, refreshToken, expiresIn: MOBILE_ACCESS_SECONDS };
}

export async function exchangeMobileCode(code: string, verifier: string) {
    if (!validMobileVerifier(verifier)) throw unauthorized();
    const codeHash = mobileHash(code);
    return db.transaction(async (tx) => {
        const [candidate] = await tx.select({ userId: sessions.userId }).from(mobileAuthorizationCodes)
            .innerJoin(sessions, eq(sessions.id, mobileAuthorizationCodes.browserSessionId)).where(eq(mobileAuthorizationCodes.codeHash, codeHash));
        if (!candidate) throw unauthorized();
        const [user] = await tx.select().from(users).where(eq(users.id, candidate.userId)).for("update");
        if (!user || user.deletedAt) throw unauthorized();
        const [row] = await tx.select({ code: mobileAuthorizationCodes, session: sessions }).from(mobileAuthorizationCodes)
            .innerJoin(sessions, eq(sessions.id, mobileAuthorizationCodes.browserSessionId))
            .where(and(eq(mobileAuthorizationCodes.codeHash, codeHash), isNull(mobileAuthorizationCodes.consumedAt), gt(mobileAuthorizationCodes.expiresAt, new Date()), gt(sessions.expiresAt, new Date())));
        if (!row || createHash("sha256").update(verifier).digest("base64url") !== row.code.challenge) throw unauthorized();
        const consumed = await tx.update(mobileAuthorizationCodes).set({ consumedAt: new Date() }).where(and(eq(mobileAuthorizationCodes.id, row.code.id), isNull(mobileAuthorizationCodes.consumedAt))).returning();
        if (!consumed.length) throw unauthorized();
        const [session] = await tx.insert(sessions).values({ userId: user.id, expiresAt: new Date(Date.now() + MOBILE_SESSION_SECONDS * 1000), userAgent: `EmperorClaw iPhone: ${row.code.deviceName}` }).returning();
        const pair = tokenPair();
        const [device] = await tx.insert(mobileSessions).values({ sessionId: session.id, deviceName: row.code.deviceName, deviceKind: "iphone", accessHash: mobileHash(pair.accessToken), refreshHash: mobileHash(pair.refreshToken), accessExpiresAt: new Date(Date.now() + MOBILE_ACCESS_SECONDS * 1000) }).returning();
        return { ...pair, deviceId: device.id };
    });
}

export async function refreshMobileToken(refreshToken: string) {
    return db.transaction(async (tx) => {
        const [candidate] = await tx.select({ userId: sessions.userId }).from(mobileSessions).innerJoin(sessions, eq(sessions.id, mobileSessions.sessionId)).where(eq(mobileSessions.refreshHash, mobileHash(refreshToken)));
        if (!candidate) throw unauthorized();
        const [user] = await tx.select().from(users).where(eq(users.id, candidate.userId)).for("update");
        if (!user || user.deletedAt) throw unauthorized();
        const [current] = await tx.select({ sessionId: sessions.id }).from(mobileSessions)
            .innerJoin(sessions, eq(sessions.id, mobileSessions.sessionId))
            .where(and(eq(mobileSessions.refreshHash, mobileHash(refreshToken)), gt(sessions.expiresAt, new Date())));
        if (!current) throw unauthorized();
        const pair = tokenPair();
        // CAS on the old refresh hash: only one concurrent refresh wins.
        const updated = await tx.update(mobileSessions).set({ accessHash: mobileHash(pair.accessToken), refreshHash: mobileHash(pair.refreshToken), accessExpiresAt: new Date(Date.now() + MOBILE_ACCESS_SECONDS * 1000) })
            .where(and(eq(mobileSessions.refreshHash, mobileHash(refreshToken)), eq(mobileSessions.sessionId, current.sessionId)))
            .returning({ deviceId: mobileSessions.id });
        if (!updated.length) throw unauthorized();
        return { ...pair, deviceId: updated[0].deviceId };
    });
}

export async function mobileIdentity(request: Request) {
    const token = request.headers.get("authorization")?.match(/^Bearer (ema_[A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw unauthorized();
    const [identity] = await db.select({ userId: users.id, instanceRole: users.instanceRole, sessionId: sessions.id, deviceId: mobileSessions.id, deviceKind: mobileSessions.deviceKind }).from(mobileSessions)
        .innerJoin(sessions, eq(sessions.id, mobileSessions.sessionId)).innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(mobileSessions.accessHash, mobileHash(token)), gt(mobileSessions.accessExpiresAt, new Date()), gt(sessions.expiresAt, new Date()), isNull(users.deletedAt)));
    if (!identity) throw unauthorized();
    return identity;
}

/** A phone authorizes a separate watch session, never transfers its own token. */
export async function pairMobileWatch(request: Request, replacingDeviceId?: string) {
    const identity = await mobileIdentity(request);
    if (identity.deviceKind !== "iphone") throw new AuthError("Pair from your iPhone", 403);
    return db.transaction(async (tx) => {
        const [user] = await tx.select().from(users).where(eq(users.id, identity.userId)).for("update");
        // Recheck after the account lock, including access expiry/revocation.
        const fresh = await mobileIdentity(request);
        if (!user || user.deletedAt || fresh.sessionId !== identity.sessionId) throw unauthorized();
        if (replacingDeviceId) {
            const [old] = await tx.select({ sessionId: sessions.id }).from(mobileSessions)
                .innerJoin(sessions, eq(sessions.id, mobileSessions.sessionId))
                .where(and(eq(mobileSessions.id, replacingDeviceId), eq(mobileSessions.deviceKind, "watch"), eq(sessions.userId, user.id)));
            if (old) await tx.delete(sessions).where(eq(sessions.id, old.sessionId));
        }
        const [session] = await tx.insert(sessions).values({ userId: user.id, expiresAt: new Date(Date.now() + MOBILE_SESSION_SECONDS * 1000), userAgent: "EmperorClaw Apple Watch" }).returning();
        const pair = tokenPair();
        const [device] = await tx.insert(mobileSessions).values({ sessionId: session.id, deviceName: "Apple Watch", deviceKind: "watch", accessHash: mobileHash(pair.accessToken), refreshHash: mobileHash(pair.refreshToken), accessExpiresAt: new Date(Date.now() + MOBILE_ACCESS_SECONDS * 1000) }).returning();
        return { ...pair, deviceId: device.id };
    });
}

export async function mobileCompanies(identity: Awaited<ReturnType<typeof mobileIdentity>>) {
    const rows = await db.select({ id: companies.id, name: companies.name, role: companyMembers.role }).from(companyMembers)
        .innerJoin(companies, eq(companies.id, companyMembers.companyId))
        .where(and(eq(companyMembers.userId, identity.userId), isNull(companies.deletedAt))).orderBy(asc(companies.name));
    if (identity.instanceRole === "instance_admin" && isSelfHosted()) {
        const company = await getInstanceCompany();
        if (company && !rows.some((row) => row.id === company.id)) {
            const [active] = await db.select({ id: companies.id }).from(companies).where(and(eq(companies.id, company.id), isNull(companies.deletedAt)));
            if (active) rows.push({ ...company, role: "instance_admin" });
        }
    }
    return rows.map((row) => ({ ...row, role: getEffectiveRole(identity.instanceRole as InstanceRole, row.role as CompanyRole) }));
}

export async function mobileCompanyAccess(request: Request, companyId: string): Promise<GuardContext> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) throw new AuthError("Company not found", 404);
    const identity = await mobileIdentity(request);
    const company = (await mobileCompanies(identity)).find((row) => row.id === companyId);
    if (!company) throw new AuthError("Company not found", 404);
    if (roleGte(company.role, "admin")) return { userId: identity.userId, companyId, role: company.role, scope: null };
    const [membership] = await db.select().from(companyMembers).where(and(eq(companyMembers.userId, identity.userId), eq(companyMembers.companyId, companyId)));
    if (!membership) throw new AuthError("Company not found", 404);
    const memberships = await loadScopeMemberships(companyId, identity.userId);
    return { userId: identity.userId, companyId, role: company.role, scope: normalizeMemberScope(membership.scopeJson, memberships), memberships };
}
