import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { companies } from "@/db/schema";
import { isNull, sql } from "drizzle-orm";
import { isSelfHosted, getRegistrationMode } from "@/lib/instance";
import { isEmailConfigured } from "@/lib/email";

/**
 * GET /api/auth/register-state
 * Public endpoint — returns the current signup state for the UI.
 * Used by the signup page to decide which form to render.
 */
export async function GET(_req: NextRequest) {
    try {
        // Cloud mode: always allow signup (bootstrap behavior = create new company)
        if (!isSelfHosted()) {
            return NextResponse.json({
                isBootstrap: false,
                registrationMode: "open",
                deploymentMode: "cloud",
                emailConfigured: isEmailConfigured(),
            });
        }

        // Self-hosted: check if any company exists
        const [countResult] = await db
            .select({ count: sql<number>`COUNT(*)::int` })
            .from(companies)
            .where(isNull(companies.deletedAt));

        const companyCount = countResult?.count ?? 0;

        if (companyCount === 0) {
            return NextResponse.json({
                isBootstrap: true,
                registrationMode: "invite-only",
                deploymentMode: "self-hosted",
                emailConfigured: isEmailConfigured(),
            });
        }

        const registrationMode = await getRegistrationMode();

        return NextResponse.json({
            isBootstrap: false,
            registrationMode,
            deploymentMode: "self-hosted",
            emailConfigured: isEmailConfigured(),
        });
    } catch (err) {
        console.error("Register-state error:", err);
        return NextResponse.json({
            isBootstrap: false,
            registrationMode: "invite-only",
            deploymentMode: "self-hosted",
            emailConfigured: isEmailConfigured(),
        }, { status: 200 });
    }
}
