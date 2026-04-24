import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users, companies, companyMembers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { consumeRateLimit, getClientIp } from "@/lib/rate-limit";
import { issueEmailVerificationToken } from "@/lib/email-verification";
import { sendEmail, getEmailVerificationEmailHtml } from "@/lib/email";
import { getAppUrl } from "@/lib/env";

function normalizeEmail(value: unknown): string {
    return String(value ?? "").trim().toLowerCase();
}

export async function POST(req: NextRequest) {
    try {
        const { email: rawEmail } = await req.json();
        const email = normalizeEmail(rawEmail);

        const rateLimit = consumeRateLimit({
            key: `auth:resend-verification:${getClientIp(req)}:${email || "unknown"}`,
            limit: 5,
            windowMs: 15 * 60 * 1000,
        });
        if (!rateLimit.allowed) {
            return NextResponse.json(
                { error: "Too many verification requests. Try again later." },
                {
                    status: 429,
                    headers: { "Retry-After": Math.ceil(rateLimit.retryAfterMs / 1000).toString() },
                },
            );
        }

        if (!email) {
            return NextResponse.json({ error: "Email is required" }, { status: 400 });
        }

        const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
        if (!user || user.emailVerifiedAt) {
            return NextResponse.json({
                message: "If the account exists and still needs activation, a new verification email has been sent.",
            }, { status: 200 });
        }

        const { rawToken } = await issueEmailVerificationToken(user.id);
        const verificationUrl = `${getAppUrl(req)}/signup/verify?token=${rawToken}&email=${encodeURIComponent(email)}`;
        const [membership] = await db.select().from(companyMembers).where(eq(companyMembers.userId, user.id)).limit(1);
        const [company] = membership
            ? await db.select().from(companies).where(eq(companies.id, membership.companyId)).limit(1)
            : [];

        await sendEmail({
            to: email,
            subject: "Verify your Emperor Claw email",
            html: getEmailVerificationEmailHtml(email, verificationUrl, company?.name || "your company"),
        });

        return NextResponse.json({
            message: "If the account exists and still needs activation, a new verification email has been sent.",
        }, { status: 200 });
    } catch (err) {
        console.error("Resend verification error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
