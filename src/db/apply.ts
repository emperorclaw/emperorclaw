import postgres from "postgres";
import fs from "fs";

import dotenv from "dotenv";
dotenv.config();

const connectionString = "postgresql://postgres:" + process.env.VPS_PASS + "@localhost:5432/emperor_claw";
const sql = postgres(connectionString);

async function main() {
    try {
        await sql.unsafe("ALTER TABLE tasks ADD COLUMN processing_started_at timestamp;");
        console.log("Migration applied successfully!");
    } catch (e) {
        console.error("Migration failed:", e);
    }
    process.exit(0);
}
main();
