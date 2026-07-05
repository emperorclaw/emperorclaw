import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { resellers } from "@/db/schema";
import { requirePlatformAdminSession } from "@/lib/platform-admin";
import { and, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";

// GET /api/admin/resellers — list resellers with search, status filter, pagination
export async function GET(req: NextRequest) {
    const admin = await requirePlatformAdminSession();
    if (!admin) {
        return NextResponse.json(
            { ok: false, error: "Unauthorized" },
            { status: 401 },
        );
    }

    try {
        const { searchParams } = new URL(req.url);
        const search = searchParams.get("search")?.trim() || "";
        const status = searchParams.get("status")?.trim() || "";
        const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
        const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "20", 10)));
        const offset = (page - 1) * limit;

        // Build where conditions
        const conditions = [isNull(resellers.deletedAt)];

        if (status && ["active", "inactive", "suspended"].includes(status)) {
            conditions.push(eq(resellers.status, status));
        }

        if (search) {
            conditions.push(
                or(
                    ilike(resellers.name, `%${search}%`),
                    ilike(resellers.email, `%${search}%`),
                ) as SQL<unknown>,
            );
        }

        const where = and(...conditions);

        // Get total count
        const [countResult] = await db
            .select({ count: sql<number>`count(*)` })
            .from(resellers)
            .where(where);

        const total = Number(countResult.count);

        // Get paginated results
        const items = await db
            .select()
            .from(resellers)
            .where(where)
            .orderBy(desc(resellers.createdAt))
            .limit(limit)
            .offset(offset);

        return NextResponse.json({
            ok: true,
            data: items,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json(
            { ok: false, error: message },
            { status: 500 },
        );
    }
}

// POST /api/admin/resellers — create a new reseller
export async function POST(req: NextRequest) {
    const admin = await requirePlatformAdminSession();
    if (!admin) {
        return NextResponse.json(
            { ok: false, error: "Unauthorized" },
            { status: 401 },
        );
    }

    try {
        const body = await req.json();

        const name = typeof body.name === "string" ? body.name.trim() : "";
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        const commissionRate = typeof body.commissionRate === "number" ? String(body.commissionRate) : "0";
        const status = typeof body.status === "string" && ["active", "inactive", "suspended"].includes(body.status)
            ? body.status
            : "active";
        const notes = typeof body.notes === "string" ? body.notes.trim() : "";
        const brandColor = typeof body.brandColor === "string" ? body.brandColor.trim() : "#6366f1";

        if (!name) {
            return NextResponse.json(
                { ok: false, error: "name is required" },
                { status: 400 },
            );
        }

        if (!email) {
            return NextResponse.json(
                { ok: false, error: "email is required" },
                { status: 400 },
            );
        }

        const [existing] = await db
            .select({ id: resellers.id })
            .from(resellers)
            .where(and(eq(resellers.email, email), isNull(resellers.deletedAt)))
            .limit(1);

        if (existing) {
            return NextResponse.json(
                { ok: false, error: "A reseller with this email already exists" },
                { status: 409 },
            );
        }

        const [newReseller] = await db
            .insert(resellers)
            .values({
                name,
                email,
                commissionRate,
                status,
                notes: notes || null,
                brandColor,
                createdBy: admin.id,
            })
            .returning();

        return NextResponse.json(
            { ok: true, data: newReseller },
            { status: 201 },
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json(
            { ok: false, error: message },
            { status: 500 },
        );
    }
}
