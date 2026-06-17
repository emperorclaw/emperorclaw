import 'dotenv/config';
import { db } from './src/db';
import { actionRuns } from './src/db/schema';
import { count } from 'drizzle-orm';

async function main() {
  try {
    console.log("Checking action_runs table...");
    const [result] = await db.select({ value: count() }).from(actionRuns);
    console.log("SUCCESS: action_runs table exists. Count:", result.value);
    process.exit(0);
  } catch (e: any) {
    console.log("--- ERROR DETECTED ---");
    console.log("Type:", typeof e);
    console.log("Message:", e.message);
    if (e.detail) console.log("Detail:", e.detail);
    if (e.hint) console.log("Hint:", e.hint);
    if (e.code) console.log("Code:", e.code);
    
    if (e.message && e.message.includes("relation \"action_runs\" does not exist")) {
      console.error("FAILURE: action_runs table does NOT exist. Migration 0007 probably NOT applied.");
    } else {
      console.error("CRITICAL DB PROBLEM:", e);
    }
    process.exit(1);
  }
}

main();
