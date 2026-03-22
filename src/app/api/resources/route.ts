export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { eq } from "drizzle-orm";
import { authOptions } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers } from "@/db/schema";
import { listScopedResources, resolveResourceScope } from "@/lib/resources";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    const user = session?.user as { id?: string } | undefined;
    if (!user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [membership] = await db.select().from(companyMembers)
      .where(eq(companyMembers.userId, user.id))
      .limit(1);

    if (!membership) {
      return NextResponse.json({ error: "Company not found" }, { status: 404 });
    }

    const rows = await listScopedResources({
      companyId: membership.companyId,
    });

    return NextResponse.json({
      resources: rows.map((resource) => ({
        ...resource,
        ...resolveResourceScope(resource),
        secretJson: undefined,
      })),
    });
  } catch (error) {
    console.error("Error fetching scoped resources:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
