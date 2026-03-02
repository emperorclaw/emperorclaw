import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users, passwordResets } from "@/db/schema";
import { eq } from "drizzle-orm";
import crypto from "crypto";
import { hash } from "argon2";
import { sendEmail, getPasswordResetEmailHtml } from "@/lib/email";

export async function POST(req: NextRequest) {
    try {
        const { email } = await req.json();

        if (!email) {
            return NextResponse.json({ error: "Email is required" }, { status: 400 });
        }

        const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

        // Security best practice: Don't reveal whether an email exists or not
        if (!user) {
            return NextResponse.json({ message: "If an account with that email exists, a reset link has been sent." }, { status: 200 });
        }

        // Generate a secure random token
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = await hash(rawToken);

        // Set expiration (e.g., 2 hours)
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 2);

        // Insert reset record
        await db.insert(passwordResets).values({
            userId: user.id,
            tokenHash,
            expiresAt
        });

        // Construct reset link
        // In production, this should ideally use the actual configured domain, 
        // but deriving it from the request origin works for an MVP.
        const origin = req.headers.get('origin') || 'https://emperorclaw.malecu.eu';
        const resetUrl = `${origin}/reset-password?token=${rawToken}&email=${encodeURIComponent(email)}`;

        // Dispatch Email
        await sendEmail({
            to: email,
            subject: "Reset your Emperor Claw Password",
            html: getPasswordResetEmailHtml(email, resetUrl)
        });

        return NextResponse.json({ message: "If an account with that email exists, a reset link has been sent." }, { status: 200 });

    } catch (err) {
        console.error("Forgot password error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
