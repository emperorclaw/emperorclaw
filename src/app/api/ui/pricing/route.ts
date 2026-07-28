import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { llmPricing } from "@/db/schema";
import { getCompanyId } from "@/lib/auth";

const pricingSchema = z.object({
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    label: z.string().trim().min(1),
    inputPricePer1k: z.number().int().min(0),
    outputPricePer1k: z.number().int().min(0),
    active: z.boolean().optional(),
});

export async function GET() {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const pricing = await db.select().from(llmPricing).orderBy(llmPricing.provider, llmPricing.model);
    return NextResponse.json({ pricing });
}

export async function POST(req: NextRequest) {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const parsed = pricingSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid pricing data" }, { status: 400 });

    const { provider, model, label, inputPricePer1k, outputPricePer1k, active } = parsed.data;
    const [existing] = await db.select({ id: llmPricing.id }).from(llmPricing)
        .where(and(eq(llmPricing.provider, provider), eq(llmPricing.model, model)))
        .limit(1);

    if (existing) {
        const [pricing] = await db.update(llmPricing).set({
            label,
            inputPricePer1k,
            outputPricePer1k,
            active: active ?? true,
        }).where(eq(llmPricing.id, existing.id)).returning();
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
    return NextResponse.json({ pricing }, { status: 201 });
}
