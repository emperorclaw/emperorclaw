import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users, companies, companyMembers } from "@/db/schema";
import { hash } from "argon2";
import { eq } from "drizzle-orm";
import { sendEmail, getWelcomeEmailHtml } from "@/lib/email";

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { email, password, companyName } = body;

        if (!email || !password || !companyName) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
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

        // Fire-and-forget the welcome email
        sendEmail({
            to: email,
            subject: "Welcome to Emperor Claw",
            html: getWelcomeEmailHtml(email)
        }).catch(err => console.error("Failed to send welcome email in background", err));

        return NextResponse.json({ message: "Account created successfully", data: result }, { status: 201 });

    } catch (err: any) {
        console.error("Registration error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
