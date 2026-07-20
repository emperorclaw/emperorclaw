import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { companyMembers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getValidatedServerSession, getCompanyId } from "@/lib/auth";

// GET /api/instance/members/[userId]/scope
export async function GET(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
    const session = await getValidatedServerSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "No company" }, { status: 400 });
    
    const companyRole = (session.user as any)?.companyRole;
    if (companyRole !== "owner" && companyRole !== "admin" && session.user?.instanceRole !== "instance_admin") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    
    const { userId } = await params;
    const [membership] = await db
        .select({ scopeJson: companyMembers.scopeJson })
        .from(companyMembers)
        .where(eq(companyMembers.userId, userId))
        .limit(1);
    
    return NextResponse.json({ scope: membership?.scopeJson || {} });
}

// PUT /api/instance/members/[userId]/scope
export async function PUT(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
    const session = await getValidatedServerSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "No company" }, { status: 400 });
    
    const companyRole = (session.user as any)?.companyRole;
    if (companyRole !== "owner" && companyRole !== "admin" && session.user?.instanceRole !== "instance_admin") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    
    const { userId } = await params;
    const body = await req.json();
    const scopeJson = body.scope || {};
    
    await db.update(companyMembers)
        .set({ scopeJson })
        .where(eq(companyMembers.userId, userId));
    
    return NextResponse.json({ ok: true, scope: scopeJson });
}
