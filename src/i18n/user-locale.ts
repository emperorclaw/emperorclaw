import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { parseLocalePreference, type Locale } from "./config";

/** A person's saved UI language: a locale, null for Automatic, undefined when there is no such user. */
export async function readUserLocale(where: { userId: string } | { email: string }): Promise<Locale | null | undefined> {
    const [row] = await db.select({ locale: users.locale }).from(users)
        .where("userId" in where ? eq(users.id, where.userId) : eq(sql`lower(${users.email})`, where.email.trim().toLowerCase()))
        .limit(1);
    if (!row) return undefined;
    return parseLocalePreference(row.locale) ?? null;
}
