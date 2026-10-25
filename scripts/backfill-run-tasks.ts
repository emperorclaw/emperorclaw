import "dotenv/config";
import { backfillRunTasks, BACKFILL_BATCH_SIZE } from "../src/lib/run-task-attribution-store";

/**
 * Attribute past runs to the task they worked on (rules in
 * src/lib/run-task-attribution.ts): (a) the single task a SYSTEM trigger
 * message names, then (c) the task the agent acted on during the run window
 * (skipped when another run of the same agent overlaps it). Only runs with no
 * task are touched, and a task is never attributed across companies or
 * outside the run agent's data scope.
 *
 *   npx tsx scripts/backfill-run-tasks.ts                      # dry run (default)
 *   npx tsx scripts/backfill-run-tasks.ts --execute            # write
 *   npx tsx scripts/backfill-run-tasks.ts --company <id> --since 2026-10-01T00:00:00Z
 */

type Args = { execute: boolean; companyId: string | null; since: Date | null; batchSize: number };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv: string[]): Args {
  const args: Args = { execute: false, companyId: null, since: null, batchSize: BACKFILL_BATCH_SIZE };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") args.execute = true;
    else if (a === "--dry-run") args.execute = false;
    else if (a === "--company") {
      const value = argv[++i];
      if (!value || !UUID_RE.test(value)) throw new Error("--company needs a company id (uuid)");
      args.companyId = value;
    } else if (a === "--since") {
      const value = argv[++i];
      const ms = value ? Date.parse(value) : NaN;
      if (Number.isNaN(ms)) throw new Error("--since needs an ISO-8601 timestamp");
      args.since = new Date(ms);
    } else if (a === "--batch-size") {
      args.batchSize = parseInt(argv[++i] || String(BACKFILL_BATCH_SIZE), 10) || BACKFILL_BATCH_SIZE;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const counts = await backfillRunTasks({
    execute: args.execute,
    companyId: args.companyId,
    since: args.since,
    batchSize: args.batchSize,
    onBatch: (progress) => console.error(`… scanned ${progress.scanned}`),
  });
  console.log(
    JSON.stringify(
      {
        dryRun: !args.execute,
        companyId: args.companyId,
        since: args.since?.toISOString() ?? null,
        scanned: counts.scanned,
        byRule: { trigger_metadata: counts.trigger_metadata, task_events: counts.task_events },
        unresolved: counts.unresolved,
        written: counts.written,
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
