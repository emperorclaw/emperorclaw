import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { llmPricing } from "@/db/schema";
import { companyRouteAccess } from "@/lib/company-access";
import { requirePlatformAdminSession } from "@/lib/platform-admin";
import { humanActor, recordAudit } from "@/lib/audit";
import { changedFields } from "@/lib/audit-format";

const pricingSchema = z.object({
    provider: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(120),
    label: z.string().trim().min(1).max(200),
    inputPricePer1k: z.number().int().min(0),
    outputPricePer1k: z.number().int().min(0),
    active: z.boolean().optional(),
});

export async function GET() {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;

    const pricing = await db.select().from(llmPricing).orderBy(llmPricing.provider, llmPricing.model);
    return NextResponse.json({ pricing });
}

/**
 * llm_pricing has no company_id: a row prices a model for every company on
 * the instance, so only platform admins (the same check as /ops) may edit it.
 */
export async function POST(req: NextRequest) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const platformAdmin = await requirePlatformAdminSession();
    if (!platformAdmin) return NextResponse.json({ error: "Only instance admins can edit model pricing" }, { status: 403 });

    const parsed = pricingSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid pricing data" }, { status: 400 });

    const { provider, model, label, inputPricePer1k, outputPricePer1k, active } = parsed.data;
    const [existing] = await db.select().from(llmPricing)
        .where(and(eq(llmPricing.provider, provider), eq(llmPricing.model, model)))
        .limit(1);

    if (existing) {
        const [pricing] = await db.update(llmPricing).set({
            label,
            inputPricePer1k,
            outputPricePer1k,
            active: active ?? true,
        }).where(eq(llmPricing.id, existing.id)).returning();
        await recordPricingAudit(access.ctx.companyId, access.ctx.userId, "pricing.updated", pricing, existing);
        return NextResponse.json({ pricing });
    }

    const [pricing] = await db.insert(llmPricing).values({
        provider,
        model,
        label,
        inputPricePer1k,
        outputPricePer1k,
        active: active ?? true,
    }).returning();
    await recordPricingAudit(access.ctx.companyId, access.ctx.userId, "pricing.created", pricing, null);
    return NextResponse.json({ pricing }, { status: 201 });
}

type PricingRow = typeof llmPricing.$inferSelect;

function pricingFields(row: PricingRow) {
    return {
        provider: row.provider, model: row.model,
        inputPricePer1k: row.inputPricePer1k, outputPricePer1k: row.outputPricePer1k, active: row.active,
    };
}

async function recordPricingAudit(companyId: string, userId: string | null | undefined,action: "pricing.created" | "pricing.updated", row: PricingRow, before: PricingRow | null) {
    const diff = before ? changedFields(pricingFields(before), pricingFields(row)) : { before: undefined, after: pricingFields(row) };
    if (Object.keys(diff.after).length === 0) return;
    await recordAudit({
        companyId, actor: humanActor(userId), action, target: { type: "pricing", id: row.id },
        before: diff.before, after: diff.after, meta: { label: row.label || row.model },
    });
}
