import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { db } from "@/db";
import { llmPricing } from "@/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { z } from "zod";

/**
 * GET  /api/mcp/pricing — list all active pricing entries
 * POST /api/mcp/pricing — add or update pricing (upsert by provider+model)
 */
export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const rows = await db.select().from(llmPricing).orderBy(llmPricing.provider, llmPricing.model);
    return NextResponse.json({ pricing: rows });
}

const upsertSchema = z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    label: z.string().min(1),
    inputPricePer1k: z.number().int().min(0),  // cents × 100 per 1K tokens
    outputPricePer1k: z.number().int().min(0), // cents × 100 per 1K tokens
    active: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    try {
        const body = await req.json();
        const parsed = upsertSchema.safeParse(body);
        if (!parsed.success) return NextResponse.json({ error: "Invalid pricing data" }, { status: 400 });

        const { provider, model, label, inputPricePer1k, outputPricePer1k, active } = parsed.data;

        // Upsert by provider + model
        const [existing] = await db.select({ id: llmPricing.id }).from(llmPricing)
            .where(and(eq(llmPricing.provider, provider), eq(llmPricing.model, model))).limit(1);

        if (existing) {
            const [updated] = await db.update(llmPricing).set({
                label, inputPricePer1k, outputPricePer1k,
                active: active ?? true,
            }).where(eq(llmPricing.id, existing.id)).returning();
            return NextResponse.json({ pricing: updated });
        }

        const [created] = await db.insert(llmPricing).values({
            provider, model, label, inputPricePer1k, outputPricePer1k,
            active: active ?? true,
        }).returning();
        return NextResponse.json({ pricing: created }, { status: 201 });
    } catch (err) {
        return NextResponse.json({ error: "Failed to save pricing" }, { status: 500 });
    }
}
