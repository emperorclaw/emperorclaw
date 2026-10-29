// Agent-bound runtime tokens: the MCP token a runtime (a managed Docker
// container, or a profile on a runtime host) holds to act as ONE agent.
// Only the sha256 hash is stored; the raw token goes to the runtime once.
//
// Kept free of Docker and Next imports: the runtime host socket server
// (server.ts) mints provisioning tokens at dispatch time.

import crypto from "crypto";
import { and, eq, isNull, like, ne } from "drizzle-orm";
import { db } from "@/db";
import { companyTokens } from "@/db/schema";

/** What a token mint/revoke runs on: the shared pool or an open transaction. */
type Executor = Pick<typeof db, "insert" | "update">;

export const LOCAL_SETUP_TOKEN_SUFFIX = "-local-setup";
/** Name prefix of tokens minted for a runtime host provision job: `host-provision:<jobId>`. */
export const HOST_PROVISION_TOKEN_PREFIX = "host-provision:";

export function hashAgentToken(rawToken: string): string {
    return crypto.createHash("sha256").update(rawToken).digest("hex");
}

/** A new `ec_` + 48 hex token bound to the agent (mcp_full): it can only ever act as that agent. */
export async function mintAgentRuntimeToken(input: {
    companyId: string;
    agentId: string | null;
    name: string;
    executor?: Executor;
}): Promise<{ rawToken: string; tokenHash: string }> {
    const rawToken = `ec_${crypto.randomBytes(24).toString("hex")}`;
    const tokenHash = hashAgentToken(rawToken);
    await (input.executor ?? db).insert(companyTokens).values({
        companyId: input.companyId,
        agentId: input.agentId || null,
        tokenHash,
        name: input.name,
        scope: "mcp_full",
    });
    return { rawToken, tokenHash };
}

/**
 * Revoke an agent's live runtime tokens whose name matches `nameLike` (a SQL
 * LIKE pattern). `keepTokenHash`: every match except that one; `onlyTokenHash`:
 * just that one. Returns how many were revoked.
 */
export async function revokeAgentRuntimeTokens(
    agentId: string,
    opts: { nameLike: string; keepTokenHash?: string | null; onlyTokenHash?: string | null; executor?: Executor },
): Promise<number> {
    const conditions = [
        eq(companyTokens.agentId, agentId),
        like(companyTokens.name, opts.nameLike),
        isNull(companyTokens.revokedAt),
    ];
    if (opts.keepTokenHash) conditions.push(ne(companyTokens.tokenHash, opts.keepTokenHash));
    if (opts.onlyTokenHash) conditions.push(eq(companyTokens.tokenHash, opts.onlyTokenHash));
    const revoked = await (opts.executor ?? db).update(companyTokens)
        .set({ revokedAt: new Date() })
        .where(and(...conditions))
        .returning({ id: companyTokens.id });
    return revoked.length;
}

/** LIKE pattern of the tokens minted for one provision job (every dispatch of it). */
export function hostProvisionTokenName(jobId: string): string {
    return `${HOST_PROVISION_TOKEN_PREFIX}${jobId}`;
}
