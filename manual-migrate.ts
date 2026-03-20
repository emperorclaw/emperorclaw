import 'dotenv/config';
import fs from 'fs';
import postgres from 'postgres';

async function main() {
  const sqlContent = fs.readFileSync('./src/db/migrations/0007_wooden_spitfire.sql', 'utf-8');
  const sqlLines = sqlContent.split('--> statement-breakpoint');

  const sql = postgres(process.env.POSTGRES_CONNECTION_STRING!);

  console.log("🚀 Starting manual SQL migration...");
  
  for (let i = 0; i < sqlLines.length; i++) {
    const stmt = sqlLines[i].trim();
    if (!stmt) continue;
    
    console.log(`Executing statement ${i+1}/${sqlLines.length}...`);
    try {
      await sql.unsafe(stmt);
    } catch (e: any) {
      if (e.message.includes("already exists")) {
        console.warn(`⚠️  Skipping: ${e.message}`);
      } else {
        console.error(`❌ ERROR in statement ${i+1}:`, e.message);
        // We continue because some might be additive
      }
    }
  }

  console.log("✅ Done.");
  process.exit(0);
}

main();
