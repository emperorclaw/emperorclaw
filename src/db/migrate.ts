import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db } from './index';

async function main() {
    console.log("🚀 Starting database migrations...");
    try {
        await migrate(db, {
            migrationsFolder: './src/db/migrations',
        });
        console.log("✅ Migrations applied successfully.");
        process.exit(0);
    } catch (error) {
        console.error("❌ Migration failed:", error);
        process.exit(1);
    }
}

main();
