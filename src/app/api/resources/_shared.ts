import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getValidatedServerSession } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers } from "@/db/schema";

export async function getResourceMembership() {
  const session = await getValidatedServerSession();
  const userId = session?.user?.id;
  if (!userId) return null;
  const [membership] = await db.select().from(companyMembers).where(eq(companyMembers.userId, userId)).limit(1);
  return membership || null;
}

export function unauthorizedResourceResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
