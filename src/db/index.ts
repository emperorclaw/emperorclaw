import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const pool = new Pool({
    connectionString: process.env.POSTGRES_CONNECTION_STRING,
    // Existing timestamp-without-time-zone columns store UTC. Keep SQL now()
    // consistent with explicit JavaScript dates regardless of the server timezone.
    options: "-c timezone=UTC",
});

export const db = drizzle(pool, { schema });
