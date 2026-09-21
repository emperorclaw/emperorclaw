import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { companies } from "@/db/schema";
import { requireRole, AuthError } from "@/lib/roles";
import { seedStarterKnowledge } from "@/lib/starter-knowledge";
import { broadcastMcpEvent } from "@/lib/pubsub";

export const dynamic = "force-dynamic";

/** Heading used to find and replace the generated block on re-runs. */
const PROFILE_HEADING = "## Company profile";

type ProfileInput = {
    companyName?: string;
    whatYouDo?: string;
    industry?: string;
    website?: string;
};

function clean(value: unknown, max: number): string {
    return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function buildProfileBlock(input: {
    companyName: string;
    whatYouDo: string;
    industry: string;
    website: string;
}): string {
    const lines = [`${PROFILE_HEADING}`, ""];
    if (input.companyName) lines.push(`- **Company:** ${input.companyName}`);
    if (input.whatYouDo) lines.push(`- **What we do:** ${input.whatYouDo}`);
    if (input.industry) lines.push(`- **Industry:** ${input.industry}`);
    if (input.website) lines.push(`- **Website:** ${input.website}`);
    lines.push("");
    lines.push("### Business rules");
    lines.push("");
    lines.push("Starter rules — edit these in Settings so every agent works the same way.");
    lines.push("");
    lines.push("- Every task has exactly one owner; the assignee closes it once the acceptance criteria are met.");
    lines.push("- External communication and pricing follow the rules recorded here before anything is sent.");
    lines.push("- When a request is unclear, ask one concrete question instead of guessing.");
    return lines.join("\n");
}

/**
 * Replace the generated profile block in place, preserving any operator-written
 * context that surrounds it. Appends when absent, so this is safe to re-run.
 */
function upsertProfileBlock(existing: string, block: string): string {
    const current = existing.trim();
    if (!current) return block;

    const start = current.indexOf(PROFILE_HEADING);
    if (start === -1) return `${current}\n\n${block}`;

    const after = current.slice(start + PROFILE_HEADING.length);
    const nextHeading = after.indexOf("\n## ");
    const tail = nextHeading === -1 ? "" : after.slice(nextHeading + 1).trimStart();
    const head = current.slice(0, start).trimEnd();

    return [head, block, tail].filter(Boolean).join("\n\n");
}

export async function GET() {
    try {
        const ctx = await requireRole("member")();
        const [company] = await db
            .select({ name: companies.name, contextNotes: companies.contextNotes })
            .from(companies)
            .where(eq(companies.id, ctx.companyId))
            .limit(1);

        if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

        return NextResponse.json({
            name: company.name,
            contextNotes: company.contextNotes ?? "",
            profileComplete: Boolean(company.contextNotes?.trim()),
        });
    } catch (error) {
        if (error instanceof AuthError) {
            return NextResponse.json({ error: error.message }, { status: error.statusCode });
        }
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    let ctx;
    try {
        // contextNotes is injected into every agent's instructions, so this is
        // an admin-only write — same boundary as PATCH /api/settings/company.
        ctx = await requireRole("admin")();
    } catch (error) {
        if (error instanceof AuthError) {
            return NextResponse.json({ error: error.message }, { status: error.statusCode });
        }
        throw error;
    }

    try {
        const body = (await req.json().catch(() => ({}))) as ProfileInput;
        const requestedName = clean(body.companyName, 120);
        const whatYouDo = clean(body.whatYouDo, 600);
        const industry = clean(body.industry, 120);
        const website = clean(body.website, 200);

        const [company] = await db
            .select({ name: companies.name, contextNotes: companies.contextNotes })
            .from(companies)
            .where(eq(companies.id, ctx.companyId))
            .limit(1);

        if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

        if (requestedName && (requestedName.length < 2 || requestedName.length > 120)) {
            return NextResponse.json({ error: "Company name must be between 2 and 120 characters." }, { status: 400 });
        }

        const companyName = requestedName || company.name;
        const block = buildProfileBlock({ companyName, whatYouDo, industry, website });
        const contextNotes = upsertProfileBlock(company.contextNotes ?? "", block);

        const [updated] = await db
            .update(companies)
            .set({ name: companyName, contextNotes })
            .where(eq(companies.id, ctx.companyId))
            .returning({ id: companies.id, name: companies.name, contextNotes: companies.contextNotes });

        const seeded = await seedStarterKnowledge({
            companyId: ctx.companyId,
            companyName,
            createdById: ctx.userId,
        });

        await broadcastMcpEvent(ctx.companyId, {
            type: "company_context_updated",
            actorUserId: ctx.userId,
            company: { id: updated.id, contextNotes: updated.contextNotes },
        });

        return NextResponse.json({
            message: "Company profile saved",
            company: { id: updated.id, name: updated.name },
            starterNotesCreated: seeded.created,
        });
    } catch (error) {
        console.error("Error saving company profile:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
