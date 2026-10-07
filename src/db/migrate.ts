import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db } from './index';
import { backfillLegacyAvatars } from '../lib/character/migrate-avatars';

async function main() {
    console.log("🚀 Starting database migrations...");
    try {
        await migrate(db, {
            migrationsFolder: './src/db/migrations',
        });
        console.log("✅ Migrations applied successfully.");

        try {
            const avatarBackfill = await backfillLegacyAvatars();
            console.log(`🎨 Avatar backfill: migrated ${avatarBackfill.migrated} of ${avatarBackfill.scanned} legacy avatars.`);
        } catch (error) {
            console.warn("⚠️  Avatar backfill skipped:", error instanceof Error ? error.message : error);
        }

        process.exit(0);
    } catch (error) {
        console.error("❌ Migration failed:", error);
        process.exit(1);
    }
}

main();
