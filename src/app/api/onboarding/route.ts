import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getValidatedServerSession } from "@/lib/auth";

type OnboardingStatus = "completed" | "dismissed";

function isOnboardingStatus(value: unknown): value is OnboardingStatus {
    return value === "completed" || value === "dismissed";
}

export async function PATCH(req: NextRequest) {
    const session = await getValidatedServerSession();
    const userId = session?.user?.id;
    if (!session || !userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const body = await req.json();
        const status = body.status;
        if (!isOnboardingStatus(status)) {
            return NextResponse.json({ error: "status must be completed or dismissed" }, { status: 400 });
        }

        const now = new Date();
        const update =
            status === "completed"
                ? { onboardingCompletedAt: now }
                : { onboardingDismissedAt: now };

        const [user] = await db
            .update(users)
            .set(update)
            .where(eq(users.id, userId))
            .returning({
                onboardingCompletedAt: users.onboardingCompletedAt,
                onboardingDismissedAt: users.onboardingDismissedAt,
            });

        return NextResponse.json({ user });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
