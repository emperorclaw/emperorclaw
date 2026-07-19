import { db } from "../src/db";

async function main() {
    const r = await db.execute(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='agents' ORDER BY ordinal_position`
    );
    for (const row of r.rows) {
        console.log(row.column_name, row.data_type);
    }
}

main().catch(console.error);
