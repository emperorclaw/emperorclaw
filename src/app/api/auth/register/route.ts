import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users, companies, companyMembers } from "@/db/schema";
import { hash } from "argon2";
import { eq } from "drizzle-orm";
import { sendEmail, getEmailVerificationEmailHtml } from "@/lib/email";
import { consumeRateLimit, getClientIp } from "@/lib/rate-limit";
import { issueEmailVerificationToken } from "@/lib/email-verification";
import { getAppUrl } from "@/lib/env";
import { recordOpsError } from "@/lib/ops-events";

interface RegisterRequestBody {
    email: string;
    password: string;
    companyName: string;
    acceptBetaDisclaimer?: boolean;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value: unknown): string {
    return String(value ?? "").trim().toLowerCase();
}

function normalizeCompanyName(value: unknown): string {
    return String(value ?? "").trim().replace(/\s+/g, " ");
}

export async function POST(req: NextRequest) {
    try {
        const body = (await req.json()) as RegisterRequestBody;
        const email = normalizeEmail(body.email);
        const password = String(body.password ?? "");
        const companyName = normalizeCompanyName(body.companyName);
        const acceptBetaDisclaimer = body.acceptBetaDisclaimer === true;

        const rateLimit = consumeRateLimit({
            key: `auth:register:${getClientIp(req)}:${email || "unknown"}`,
            limit: 5,
            windowMs: 15 * 60 * 1000,
        });
        if (!rateLimit.allowed) {
            return NextResponse.json(
                { error: "Too many signup attempts. Try again later." },
                {
                    status: 429,
                    headers: { "Retry-After": Math.ceil(rateLimit.retryAfterMs / 1000).toString() },
                },
            );
        }

        if (!email || !password || !companyName) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }

        if (!acceptBetaDisclaimer) {
            return NextResponse.json({
                error: "You must acknowledge the beta data disclaimer before creating a workspace."
            }, { status: 400 });
        }

        if (!EMAIL_REGEX.test(email) || email.length > 254) {
            return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
        }

        if (companyName.length < 2 || companyName.length > 120) {
            return NextResponse.json({
                error: "Company name must be between 2 and 120 characters."
            }, { status: 400 });
        }

        if (password.length < 8 || password.length > 128) {
            return NextResponse.json({
                error: "Password must be between 8 and 128 characters."
            }, { status: 400 });
        }

        // Check if user already exists
        const [existingUser] = await db.select().from(users).where(eq(users.email, email)).limit(1);
        if (existingUser) {
            return NextResponse.json({ error: "Email already in use" }, { status: 400 });
        }

        const passwordHash = await hash(password);

        // We use a transaction to ensure all 3 entities are created together
        const result = await db.transaction(async (tx) => {
            // 1. Create the User
            const [newUser] = await tx.insert(users).values({
                email,
                passwordHash,
            }).returning();

            // 2. Create the Company
            const [newCompany] = await tx.insert(companies).values({
                name: companyName,
                createdByUserId: newUser.id,
            }).returning();

            // 3. Link them as an admin member
            await tx.insert(companyMembers).values({
                companyId: newCompany.id,
                userId: newUser.id,
                role: "owner",
            });

            return { user: { id: newUser.id, email: newUser.email }, company: newCompany };
        });

        const { rawToken } = await issueEmailVerificationToken(result.user.id);
        const verificationUrl = `${getAppUrl(req)}/signup/verify?token=${rawToken}&email=${encodeURIComponent(email)}`;

        await sendEmail({
            to: email,
            subject: "Verify your Emperor Claw email",
            html: getEmailVerificationEmailHtml(email, verificationUrl, result.company.name),
        });

        return NextResponse.json({
            message: "Account created. Check your inbox to verify your email before logging in.",
            data: {
                email,
                companyId: result.company.id,
                companyName: result.company.name,
            },
        }, { status: 201 });

    } catch (err: unknown) {
        console.error("Registration error:", err);
        void recordOpsError({
            category: "auth",
            source: "auth.register",
            fallbackMessage: "Registration failed",
            error: err,
            route: "/api/auth/register",
            method: "POST",
        });
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
