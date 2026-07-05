import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { resellers } from "@/db/schema";
import { requirePlatformAdminSession } from "@/lib/platform-admin";
import { and, eq, isNull, sql } from "drizzle-orm";

type RouteContext = {
    params: Promise<{ id: string }>;
};

async function getResellerById(id: string) {
    const [reseller] = await db
        .select()
        .from(resellers)
        .where(and(eq(resellers.id, id), isNull(resellers.deletedAt)))
        .limit(1);
    return reseller || null;
}

// GET /api/admin/resellers/[id] — get single reseller
export async function GET(
    req: NextRequest,
    context: RouteContext,
) {
    const admin = await requirePlatformAdminSession();
    if (!admin) {
        return NextResponse.json(
            { ok: false, error: "Unauthorized" },
            { status: 401 },
        );
    }

    try {
        const { id } = await context.params;
        const reseller = await getResellerById(id);

        if (!reseller) {
            return NextResponse.json(
                { ok: false, error: "Reseller not found" },
                { status: 404 },
            );
        }

        return NextResponse.json({ ok: true, data: reseller });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json(
            { ok: false, error: message },
            { status: 500 },
        );
    }
}

// PATCH /api/admin/resellers/[id] — update reseller
export async function PATCH(
    req: NextRequest,
    context: RouteContext,
) {
    const admin = await requirePlatformAdminSession();
    if (!admin) {
        return NextResponse.json(
            { ok: false, error: "Unauthorized" },
            { status: 401 },
        );
    }

    try {
        const { id } = await context.params;
        const existing = await getResellerById(id);

        if (!existing) {
            return NextResponse.json(
                { ok: false, error: "Reseller not found" },
                { status: 404 },
            );
        }

        const body = await req.json();

        // Build update object with only provided fields
        const updateData: Record<string, unknown> = {};

        if (body.name !== undefined) {
            const name = String(body.name).trim();
            if (!name) {
                return NextResponse.json(
                    { ok: false, error: "name cannot be empty" },
                    { status: 400 },
                );
            }
            updateData.name = name;
        }

        if (body.email !== undefined) {
            const email = String(body.email).trim().toLowerCase();
            if (!email) {
                return NextResponse.json(
                    { ok: false, error: "email cannot be empty" },
                    { status: 400 },
                );
            }

            // Check email uniqueness (exclude current reseller by ID)
            const [other] = await db
                .select({ id: resellers.id })
                .from(resellers)
                .where(
                    and(
                        eq(resellers.email, email),
                        isNull(resellers.deletedAt),
                        // Use sql inequality for UUID comparison since drizzle's ne() may not support UUID columns
                        sql`${resellers.id} != ${id}::uuid`,
                    ),
                )
                .limit(1);

            if (other) {
                return NextResponse.json(
                    { ok: false, error: "A reseller with this email already exists" },
                    { status: 409 },
                );
            }

            updateData.email = email;
        }

        if (body.commissionRate !== undefined) {
            updateData.commissionRate = String(body.commissionRate);
        }

        if (body.status !== undefined) {
            if (!["active", "inactive", "suspended"].includes(body.status)) {
                return NextResponse.json(
                    { ok: false, error: "Invalid status. Must be one of: active, inactive, suspended" },
                    { status: 400 },
                );
            }
            updateData.status = body.status;
        }

        if (body.notes !== undefined) {
            updateData.notes = String(body.notes).trim() || null;
        }

        if (body.brandColor !== undefined) {
            updateData.brandColor = String(body.brandColor).trim();
        }

        if (Object.keys(updateData).length === 0) {
            return NextResponse.json(
                { ok: false, error: "No fields to update" },
                { status: 400 },
            );
        }

        // Set updatedAt timestamp
        updateData.updatedAt = new Date();

        const [updated] = await db
            .update(resellers)
            .set(updateData)
            .where(and(eq(resellers.id, id), isNull(resellers.deletedAt)))
            .returning();

        return NextResponse.json({ ok: true, data: updated });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json(
            { ok: false, error: message },
            { status: 500 },
        );
    }
}

// DELETE /api/admin/resellers/[id] — soft delete reseller
export async function DELETE(
    req: NextRequest,
    context: RouteContext,
) {
    const admin = await requirePlatformAdminSession();
    if (!admin) {
        return NextResponse.json(
            { ok: false, error: "Unauthorized" },
            { status: 401 },
        );
    }

    try {
        const { id } = await context.params;
        const existing = await getResellerById(id);

        if (!existing) {
            return NextResponse.json(
                { ok: false, error: "Reseller not found" },
                { status: 404 },
            );
        }

        const [deleted] = await db
            .update(resellers)
            .set({
                deletedAt: new Date(),
                status: "inactive",
                updatedAt: new Date(),
            })
            .where(and(eq(resellers.id, id), isNull(resellers.deletedAt)))
            .returning();

        return NextResponse.json({ ok: true, data: deleted });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json(
            { ok: false, error: message },
            { status: 500 },
        );
    }
}
