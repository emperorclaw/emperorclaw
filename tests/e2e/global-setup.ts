import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";

/**
 * Fixture for the browser suite. Needs-attention entries only exist once
 * something actually needs a person, so mark the oldest open seeded task
 * `humanApprovalRequired`: that is one of the two ways lib/attention.ts builds
 * an approval entry (the implicit branch), and it needs no approval row, no
 * agent and no message. A no-op when the suite runs against someone else's
 * instance (E2E_BASE_URL) or without a database URL.
 */
export default async function globalSetup() {
  const envFile = resolve(__dirname, "../../.env");
  if (existsSync(envFile)) loadEnv({ path: envFile, quiet: true });

  const connectionString = process.env.POSTGRES_CONNECTION_STRING;
  if (process.env.E2E_BASE_URL || !connectionString) return;

  const { default: postgres } = await import("postgres");
  const sql = postgres(connectionString, { max: 1 });
  try {
    // A fresh install opens the "Emperor setup" modal over everything (it is
    // modal on purpose), so the signed-in fixture user must be past onboarding
    // or the dashboard is not clickable.
    const onboarded = await sql`
      update users set onboarding_completed_at = coalesce(onboarding_completed_at, now()),
                       onboarding_dismissed_at = coalesce(onboarding_dismissed_at, now())
      where email = ${process.env.E2E_EMAIL ?? "admin@acme.com"}
      returning id
    `;
    if (onboarded.length > 0) console.log("[e2e] onboarding marked complete for the fixture user");

    const updated = await sql`
      update tasks set human_approval_required = true
      where id = (
        select id from tasks
        where deleted_at is null and state <> 'done'
        order by created_at
        limit 1
      )
      returning id, human_approval_required
    `;
    if (updated.length > 0) console.log(`[e2e] task ${updated[0].id} needs human approval (needs-attention fixture)`);
    else console.log("[e2e] no open task to use as a needs-attention fixture");
  } finally {
    await sql.end();
  }
}
