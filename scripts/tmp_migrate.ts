import * as dotenv from "dotenv";
dotenv.config();

import { Client } from "pg";

async function migrate() {
    const connectionString = process.env.POSTGRES_CONNECTION_STRING;
    console.log("Applying manual column migrations to", connectionString);
    
    // Manual config to be safe
    const client = new Client({
        connectionString,
        ssl: false,
    });

    try {
        await client.connect();
        await client.query(`
            ALTER TABLE thread_participants 
            ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMP,
            ADD COLUMN IF NOT EXISTS typing_until TIMESTAMP;
        `);
        console.log("✅ Success: Added last_read_at and typing_until to thread_participants");
        await client.end();
    } catch (error) {
        console.error("❌ Failed:", error);
    }
}

migrate();
