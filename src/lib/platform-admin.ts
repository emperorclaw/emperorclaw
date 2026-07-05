import { db } from "@/db";
import { users, platformAdmins } from "@/db/schema";
import { getValidatedServerSession } from "@/lib/auth";
import { eq } from "drizzle-orm";

// Fallback: check env var for email-based admin list (legacy)
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

    // First check: DB-based platform_admins table
    const [dbAdmin] = await db.select({
        role: platformAdmins.role,
    }).from(platformAdmins).where(eq(platformAdmins.userId, userId)).limit(1);

    if (dbAdmin) {
        return {
            ...user,
            isPlatformAdmin: true,
            adminRole: dbAdmin.role,
            reason: null,
        };
    }

    // Fallback check: email-based env var list
    const allowedEmails = getConfiguredPlatformAdminEmails();
    if (allowedEmails.length > 0 && allowedEmails.includes(user.email.toLowerCase())) {
        return {
            ...user,
            isPlatformAdmin: true,
            adminRole: "admin",
            reason: null,
        };
    }

    return {
        ...user,
        isPlatformAdmin: false,
        adminRole: null,
        reason: allowedEmails.length === 0
            ? "Platform admin emails are not configured."
            : "Your account is not listed as a platform admin.",
    };
}

export async function requirePlatformAdminSession() {
    const platformAdmin = await getPlatformAdminSession();
    if (!platformAdmin?.isPlatformAdmin) {
        return null;
    }

    return platformAdmin;
}
