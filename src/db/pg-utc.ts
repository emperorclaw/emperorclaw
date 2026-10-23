import { defaults, types } from "pg";

// Timestamp columns are `timestamp without time zone` and store UTC. node-postgres
// serializes a JavaScript Date parameter in the process's local time unless told
// otherwise, so a raw sql`... ${date}` on a server that does not run in UTC
// compared and wrote times shifted by its offset (live runs were swept as lost a
// minute in). Typed Drizzle columns already send ISO strings; this covers the rest.
defaults.parseInputDatesAsUTC = true;

// The same applies when reading: raw queries parse `timestamp` (OID 1114) as local
// time. Drizzle passes its own parsers for its queries, so this only affects raw pg.
const TIMESTAMP_OID = 1114;
types.setTypeParser(TIMESTAMP_OID, (value: string) =>
    /^-?infinity$/.test(value) ? new Date(value.startsWith("-") ? -8.64e15 : 8.64e15) : new Date(value.replace(" ", "T") + "Z"));

/** Session option for every pool: keep SQL now() in UTC too. */
export const UTC_SESSION_OPTIONS = "-c timezone=UTC";
