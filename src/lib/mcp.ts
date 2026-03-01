import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { companyTokens, idempotencyKeys, auditLog } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import * as crypto from "crypto";

export async function verifyMcpToken(req: NextRequest) {
    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return { error: "Missing or invalid Authorization header", status: 401 };
    }

    const token = authHeader.split(" ")[1];
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const [companyToken] = await db.select().from(companyTokens).where(
        eq(companyTokens.tokenHash, tokenHash)
    ).limit(1);

    if (!companyToken || companyToken.revokedAt) {
        return { error: "Invalid or revoked token", status: 401 };
    }

    // Update lastUsedAt asynchronously
    db.update(companyTokens).set({ lastUsedAt: new Date() }).where(eq(companyTokens.id, companyToken.id)).execute().catch(console.error);

    return { companyToken };
}

export async function checkIdempotency(req: NextRequest, companyId: string, endpoint: string) {
    const idempotencyKey = req.headers.get("Idempotency-Key");
    if (!idempotencyKey) {
        return { error: "Idempotency-Key header is required", status: 400 };
    }

    // Generate request hash (simplified by just using the key and endpoint)
    const requestHash = crypto.createHash('sha256').update(`${idempotencyKey}:${endpoint}`).digest('hex');

    const [existing] = await db.select().from(idempotencyKeys).where(
        and(
            eq(idempotencyKeys.companyId, companyId),
            eq(idempotencyKeys.requestHash, requestHash)
        )
    ).limit(1);

    if (existing && existing.responseSnapshot) {
        return { cachedResponse: existing.responseSnapshot };
    }

    return { requestHash };
}

export async function saveIdempotencyResponse(companyId: string, endpoint: string, requestHash: string, responseObj: any) {
    await db.insert(idempotencyKeys).values({
        companyId,
        endpoint,
        requestHash,
        responseSnapshot: responseObj,
    });
}

import { agents } from "@/db/schema";
export async function resolveAgentId(companyId: string, providedAgentId: string): Promise<string> {
    // 1. Try to fetch existing agent UUID by their string name identifier
    const [agent] = await db.select().from(agents).where(
        and(eq(agents.companyId, companyId), eq(agents.name, providedAgentId))
    ).limit(1);

    if (agent) return agent.id;

    // 2. If it's literally a valid UUID passed already, just check it exists
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(providedAgentId)) {
        const [existing] = await db.select().from(agents).where(
            and(eq(agents.companyId, companyId), eq(agents.id, providedAgentId))
        ).limit(1);
        if (existing) return existing.id;
    }

    // 3. Fallback: auto-register this new agent string with a fresh UUID
    const [newAgent] = await db.insert(agents).values({
        companyId,
        name: providedAgentId,
        status: "online",
        role: "operator",
    }).returning();

    return newAgent.id;
}

export async function logAudit(companyId: string, actorType: string, actorId: string | null, action: string, targetType: string, targetId: string, payload: any = {}) {
    await db.insert(auditLog).values({
        companyId,
        actorType,
        actorId,
        action,
        targetType,
        targetId,
        payloadJson: payload,
    }).execute().catch(console.error);
}
