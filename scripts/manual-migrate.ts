import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import postgres from 'postgres';

async function main() {
  const migrationsDir = './src/db/migrations';
  const migrationFiles = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const sql = postgres(process.env.POSTGRES_CONNECTION_STRING!);

  console.log(`🚀 Starting manual SQL migrations from ${migrationsDir}...`);
  console.log(`Found ${migrationFiles.length} migration files.`);
  
  for (const file of migrationFiles) {
    console.log(`\n📄 Processing ${file}...`);
    const filePath = path.join(migrationsDir, file);
    const sqlContent = fs.readFileSync(filePath, 'utf-8');
    const sqlLines = sqlContent.split('--> statement-breakpoint');

    for (let i = 0; i < sqlLines.length; i++) {
        const stmt = sqlLines[i].trim();
        if (!stmt) continue;
        
        // Very basic log for long statements
        const logStmt = stmt.length > 100 ? stmt.substring(0, 100) + '...' : stmt;
        // console.log(`Executing: ${logStmt}`);
        
        try {
          await sql.unsafe(stmt);
          process.stdout.write('.');
        } catch (e: any) {
          if (e.message.includes("already exists") || e.message.includes("already a column")) {
            // process.stdout.write('s');
          } else {
            console.error(`\n❌ ERROR in ${file} statement ${i+1}:`, e.message);
            // Some migrations might fail but we want to try the rest
          }
        }
    }
    console.log(`\n✅ Finished ${file}`);
  }

  console.log("\n🎊 All migrations processed.");
  process.exit(0);
}

main();

