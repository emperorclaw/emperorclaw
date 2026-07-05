import { db } from "@/db";
import { users } from "@/db/schema";
import { getValidatedServerSession } from "@/lib/auth";
import { eq } from "drizzle-orm";

function getConfiguredPlatformAdminEmails() {
    const raw = process.env.EMPEROR_PLATFORM_ADMIN_EMAILS || process.env.PLATFORM_ADMIN_EMAILS || "";
    return raw
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
}

export async function getPlatformAdminSession() {
    const session = await getValidatedServerSession();
    const userId = session?.user?.id;
    if (!userId) {
        return null;
    }

    const [user] = await db.select({
        id: users.id,
        email: users.email,
    }).from(users).where(eq(users.id, userId)).limit(1);

    if (!user) {
        return null;
    }

    const allowedEmails = getConfiguredPlatformAdminEmails();
    if (allowedEmails.length === 0) {
        return {
            ...user,
            isPlatformAdmin: false,
            reason: "Platform admin emails are not configured.",
        };
    }

    const isPlatformAdmin = allowedEmails.includes(user.email.toLowerCase());

    return {
        ...user,
        isPlatformAdmin,
        reason: isPlatformAdmin ? null : "Your account is not listed as a platform admin.",
    };
}

export async function requirePlatformAdminSession() {
    const platformAdmin = await getPlatformAdminSession();
    if (!platformAdmin?.isPlatformAdmin) {
        return null;
    }

    return platformAdmin;
}
