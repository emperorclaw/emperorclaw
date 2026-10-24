/**
 * One-off data migration: shorten overlong project names.
 *
 * Agents used to write a whole brief into `projects.goal`, which is the name
 * shown on the board. For every live project whose goal is longer than
 * PROJECT_NAME_MAX this splits it with splitProjectTitle (lib/project-title.ts):
 *   - `goal` becomes the short name,
 *   - the rest is saved as a "Purpose" project note (project_memory, tag
 *     project-purpose), the same place new auto-split projects put it.
 * Nothing is lost: when a name has to be clipped the note keeps the full text.
 *
 * Dry run by default (prints old -> new). Apply with --execute.
 *   npx tsx scripts/split-long-project-names.ts [--companyId <uuid>] [--execute]
 *
 * If projects later get a real `description` column, backfill it from these
 * project-purpose notes instead of splitting names again.
 */
import "dotenv/config";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../src/db";
import { projectMemory, projects } from "../src/db/schema";
import { PROJECT_NAME_MAX, splitProjectTitle } from "../src/lib/project-title";

function parseArgs(argv: string[]) {
    const args = { companyId: undefined as string | undefined, execute: false };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === "--execute") args.execute = true;
        else if (argv[i] === "--dry-run") args.execute = false;
        else if (argv[i] === "--companyId") args.companyId = argv[++i];
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv);
    const conditions = [isNull(projects.deletedAt), sql`char_length(${projects.goal}) > ${PROJECT_NAME_MAX}`];
    if (args.companyId) conditions.push(eq(projects.companyId, args.companyId));
    const rows = await db.select({ id: projects.id, companyId: projects.companyId, goal: projects.goal }).from(projects).where(and(...conditions));

    console.log(`${rows.length} project(s) with a name over ${PROJECT_NAME_MAX} characters${args.execute ? "" : " (dry run, pass --execute to apply)"}`);
    let changed = 0;
    for (const row of rows) {
        const { name, description } = splitProjectTitle(row.goal);
        if (!name || name === row.goal) continue;
        console.log(`\n${row.id}\n  old: ${row.goal}\n  new: ${name}\n  note: ${description ?? "(none)"}`);
        if (!args.execute) continue;
        await db.transaction(async (tx) => {
            await tx.update(projects).set({ goal: name, updatedAt: new Date() }).where(eq(projects.id, row.id));
            if (description) {
                await tx.insert(projectMemory).values({
                    companyId: row.companyId,
                    projectId: row.id,
                    content: `**Purpose**\n\n${description}`,
                    tags: ["project-purpose", "migrated-from-name"],
                });
            }
        });
        changed += 1;
    }
    console.log(args.execute ? `\nUpdated ${changed} project(s).` : "\nNo changes written.");
    process.exit(0);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
