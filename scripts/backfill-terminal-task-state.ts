import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../src/db";

type Args = {
  companyId?: string;
  dryRun: boolean;
  limit: number;
  repairReviewOverride: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: true, limit: 500, repairReviewOverride: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") args.dryRun = false;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--companyId") args.companyId = argv[++i];
    else if (a === "--limit") args.limit = parseInt(argv[++i] || "500", 10);
    else if (a === "--repair-review-override") args.repairReviewOverride = true;
  }
  return args;
}

async function main() {
  const { companyId, dryRun, limit, repairReviewOverride } = parseArgs(process.argv);

  const companyFilterSql = companyId
    ? sql`AND t.company_id = ${companyId}::uuid`
    : sql``;

  if (repairReviewOverride) {
    const candidateRows = await db.execute(sql`
      WITH candidates AS (
        SELECT DISTINCT
          t.company_id,
          t.id AS task_id,
          t.state AS current_state,
          'done' AS desired_state,
          (
            SELECT MAX(te.created_at)
            FROM task_events te
            WHERE te.company_id = t.company_id
              AND te.task_id = t.id
              AND te.event_type = 'task_review'
              AND te.payload_json ? 'output'
          ) AS evidence_event_at
        FROM tasks t
        WHERE t.deleted_at IS NULL
          AND t.state IN ('review', 'needs_review')
          AND t.proof_required = true
          AND t.human_approval_required = true
          AND EXISTS (
            SELECT 1
            FROM task_events te
            WHERE te.company_id = t.company_id
              AND te.task_id = t.id
              AND te.event_type = 'task_review'
              AND te.payload_json ? 'output'
          )
          ${companyFilterSql}
        ORDER BY evidence_event_at DESC NULLS LAST
        LIMIT ${limit}
      )
      SELECT * FROM candidates;
    `);

    const candidates = candidateRows.rows as Array<{
      company_id: string;
      task_id: string;
      current_state: string;
      desired_state: "done";
      evidence_event_at: string | null;
    }>;

    console.log(
      JSON.stringify(
        {
          dryRun,
          mode: "review_override",
          companyId: companyId ?? null,
          limit,
          candidates: candidates.length,
          sample: candidates.slice(0, 5),
        },
        null,
        2
      )
    );

    if (dryRun || candidates.length === 0) return;

    const updated = await db.execute(sql`
      WITH candidates AS (
        SELECT DISTINCT t.company_id, t.id AS task_id
        FROM tasks t
        WHERE t.deleted_at IS NULL
          AND t.state IN ('review', 'needs_review')
          AND t.proof_required = true
          AND t.human_approval_required = true
          AND EXISTS (
            SELECT 1
            FROM task_events te
            WHERE te.company_id = t.company_id
              AND te.task_id = t.id
              AND te.event_type = 'task_review'
              AND te.payload_json ? 'output'
          )
          ${companyFilterSql}
        LIMIT ${limit}
      )
      UPDATE tasks t
      SET state = 'done',
          updated_at = NOW()
      FROM candidates c
      WHERE t.company_id = c.company_id
        AND t.id = c.task_id
      RETURNING t.company_id, t.id AS task_id, t.state AS new_state;
    `);

    console.log(
      JSON.stringify(
        { updated: updated.rows.length, sample: updated.rows.slice(0, 10) },
        null,
        2
      )
    );

    return;
  }

  const candidateRows = await db.execute(sql`
      WITH latest_terminal AS (
        SELECT DISTINCT ON (te.company_id, te.task_id)
          te.company_id,
          te.task_id,
          te.event_type,
          te.created_at
        FROM task_events te
        WHERE te.event_type IN ('task_done', 'task_failed')
        ORDER BY te.company_id, te.task_id, te.created_at DESC
      ),
      candidates AS (
        SELECT
          t.company_id,
          t.id AS task_id,
          t.state AS current_state,
          CASE lt.event_type
            WHEN 'task_done' THEN 'done'
            WHEN 'task_failed' THEN 'failed'
          END AS desired_state,
          lt.created_at AS terminal_event_at
        FROM tasks t
        JOIN latest_terminal lt
          ON lt.company_id = t.company_id
         AND lt.task_id = t.id
        WHERE t.deleted_at IS NULL
          AND t.state NOT IN ('done', 'failed')
          ${companyFilterSql}
        ORDER BY lt.created_at DESC
        LIMIT ${limit}
      )
      SELECT * FROM candidates;
    `);

  const candidates = candidateRows.rows as Array<{
    company_id: string;
    task_id: string;
    current_state: string;
    desired_state: "done" | "failed";
    terminal_event_at: string;
  }>;

  console.log(
    JSON.stringify(
      {
        dryRun,
        mode: "terminal_events",
        companyId: companyId ?? null,
        limit,
        candidates: candidates.length,
        sample: candidates.slice(0, 5),
      },
      null,
      2
    )
  );

  if (dryRun || candidates.length === 0) return;

  const updated = await db.execute(sql`
      WITH latest_terminal AS (
        SELECT DISTINCT ON (te.company_id, te.task_id)
          te.company_id,
          te.task_id,
          te.event_type,
          te.created_at
        FROM task_events te
        WHERE te.event_type IN ('task_done', 'task_failed')
        ORDER BY te.company_id, te.task_id, te.created_at DESC
      ),
      candidates AS (
        SELECT
          t.company_id,
          t.id AS task_id,
          CASE lt.event_type
            WHEN 'task_done' THEN 'done'
            WHEN 'task_failed' THEN 'failed'
          END AS desired_state
        FROM tasks t
        JOIN latest_terminal lt
          ON lt.company_id = t.company_id
         AND lt.task_id = t.id
        WHERE t.deleted_at IS NULL
          AND t.state NOT IN ('done', 'failed')
          ${companyFilterSql}
        LIMIT ${limit}
      )
      UPDATE tasks t
      SET state = c.desired_state,
          updated_at = NOW()
      FROM candidates c
      WHERE t.company_id = c.company_id
        AND t.id = c.task_id
      RETURNING t.company_id, t.id AS task_id, t.state AS new_state;
    `);

  console.log(
    JSON.stringify(
      { updated: updated.rows.length, sample: updated.rows.slice(0, 10) },
      null,
      2
    )
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
