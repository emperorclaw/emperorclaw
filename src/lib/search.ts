/**
 * Global search (roadmap 11.5): one ranked full-text query over everything a
 * signed-in person may open, read through the SQL-only `search_vector`
 * columns of migration 0064.
 *
 * Access is decided in SQL, per type, with the same rules as the pages that
 * open each result:
 * - company: every row is filtered by the viewer's company;
 * - deleted/archived rows (deleted_at, archived threads, tasks of deleted
 *   projects) never match;
 * - restricted members (lib/member-scope.ts): projects, tasks and their notes
 *   follow the project's customer (and a task held by an agent outside the
 *   scope stays hidden, as in the palette); files follow memberRecordCondition;
 *   Knowledge & Rules notes follow memberMaySeeResource; agents and customers
 *   their allow-lists; a message only when every agent on it is in scope;
 * - private direct chats (lib/direct-chat-mode.ts userMayUseThread): only the
 *   owner's own; an orphaned one belongs to nobody;
 * - agent pair threads (lib/groups.ts isAgentPairThread): owners/admins only,
 *   as in GET /api/chat.
 * Unknown thread types are never searched (fail closed).
 */

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { directThreadLink } from "@/lib/direct-chat-mode";
import { AGENT_PAIR_DESCRIPTION } from "@/lib/groups";
import type { MemberScope } from "@/lib/member-scope";
import { agentsNotUsableBy } from "@/lib/agent-access-server";
import {
    buildTsQuery, encodeSearchCursor, HEADLINE_START, HEADLINE_STOP, parseHeadline, plainText, SEARCH_MAX_OFFSET,
    SEARCH_TYPES, type SearchResponse, type SearchResult, type SearchType,
} from "@/lib/search-query";

export type SearchViewer = {
    companyId: string;
    userId: string;
    /** Owners/admins: may read agent pair threads. */
    isAdmin: boolean;
    /** null = unrestricted. */
    scope: MemberScope | null;
};

export type SearchOptions = {
    q: string;
    types?: readonly SearchType[];
    limit: number;
    offset?: number;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONFIG = sql.raw(`'emperor_search'::regconfig`);
/** Characters of a body handed to ts_headline (it re-parses the text per row). */
const HEADLINE_SOURCE_CHARS = 20_000;
const HEADLINE_OPTIONS = `StartSel=${HEADLINE_START}, StopSel=${HEADLINE_STOP}, MaxWords=28, MinWords=12, ShortWord=2, MaxFragments=2, FragmentDelimiter=" … "`;

/** A uuid[] literal of the valid ids (an empty list matches nothing under ANY). */
function uuidArray(ids: readonly string[] | undefined): SQL {
    const valid = (ids ?? []).filter((id) => UUID_RE.test(id));
    return valid.length ? sql`ARRAY[${sql.join(valid.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[]` : sql`ARRAY[]::uuid[]`;
}

/** ts_rank (length-normalised) blended with recency: a month-old hit keeps ~75% of its weight. */
function score(vector: SQL, updatedAt: SQL): SQL {
    return sql`(ts_rank(${vector}, q.query, 1) * (0.6 + 0.4 * exp(-greatest(extract(epoch from (now() - ${updatedAt})), 0) / 2592000.0)))`;
}

type Branch = { type: SearchType; sql: SQL };

/** Every branch selects the same columns: type, id, title, body, context, a1..a3 (href parts), updated_at, score. */
function branches(viewer: SearchViewer, perBranch: number, limited: { hidden: ReadonlySet<string>; metadata: ReadonlySet<string> }): Branch[] {
    const { companyId, userId, scope } = viewer;
    // Agents limited to other people (0.20): never their messages; their names
    // only for owners/admins (who see them as metadata).
    const unusable = uuidArray([...limited.hidden]);
    const unlisted = uuidArray([...limited.hidden].filter((id) => !(viewer.isAdmin && limited.metadata.has(id))));
    const agents = uuidArray(scope?.agentIds);
    const customers = uuidArray(scope?.customerIds);
    const grantedProjects = uuidArray(scope?.projectIds);
    const restricted = Boolean(scope);
    const when = (condition: SQL) => (restricted ? sql`AND ${condition}` : sql``);
    const taskTitle = sql`coalesce(nullif(btrim(t.input_json->>'title'), ''), t.task_type)`;
    const taskInScope = when(sql`(p.customer_id = ANY(${customers}) OR p.id = ANY(${grantedProjects})) AND (t.assigned_agent_id IS NULL OR t.assigned_agent_id = ANY(${agents}))`);
    const limit = sql`LIMIT ${perBranch}`;

    return [
        {
            type: "task",
            sql: sql`(SELECT 'task'::text AS type, t.id::text AS id, ${taskTitle} AS title,
                    coalesce(t.input_json->>'description', '')
                        || CASE WHEN t.input_json->>'goal' IS DISTINCT FROM t.input_json->>'description' THEN ' ' || coalesce(t.input_json->>'goal', '') ELSE '' END
                        || ' ' || coalesce(t.input_json->>'brief', '') AS body,
                    p.goal AS context, t.project_id::text AS a1, t.id::text AS a2, NULL::text AS a3,
                    t.updated_at AS updated_at, ${score(sql`t.search_vector`, sql`t.updated_at`)} AS score
                FROM tasks t
                JOIN projects p ON p.id = t.project_id AND p.company_id = ${companyId}::uuid AND p.deleted_at IS NULL
                CROSS JOIN q
                WHERE t.company_id = ${companyId}::uuid AND t.deleted_at IS NULL AND t.search_vector @@ q.query ${taskInScope}
                ORDER BY score DESC ${limit})`,
        },
        {
            type: "task",
            sql: sql`(SELECT 'task'::text AS type, te.id::text AS id, 'Note on ' || ${taskTitle} AS title,
                    coalesce(te.payload_json->>'note', '') AS body,
                    p.goal AS context, t.project_id::text AS a1, t.id::text AS a2, NULL::text AS a3,
                    te.created_at AS updated_at, ${score(sql`te.search_vector`, sql`te.created_at`)} AS score
                FROM task_events te
                JOIN tasks t ON t.id = te.task_id AND t.company_id = ${companyId}::uuid AND t.deleted_at IS NULL
                JOIN projects p ON p.id = t.project_id AND p.company_id = ${companyId}::uuid AND p.deleted_at IS NULL
                CROSS JOIN q
                WHERE te.company_id = ${companyId}::uuid AND te.event_type IN ('task_note', 'task_handoff') AND te.search_vector @@ q.query ${taskInScope}
                ORDER BY score DESC ${limit})`,
        },
        {
            type: "message",
            sql: sql`(SELECT 'message'::text AS type, tm.id::text AS id,
                    CASE th.type
                        WHEN 'team' THEN 'Team chat'
                        WHEN 'direct' THEN coalesce(da.name, 'Direct chat')
                        ELSE coalesce(nullif(th.title, ''), 'Group chat')
                    END AS title,
                    tm.text AS body,
                    CASE
                        WHEN tm.sender_type = 'agent' THEN sa.name
                        WHEN tm.sender_type IN ('human', 'user') THEN coalesce(nullif(su.display_name, ''), 'A teammate')
                        ELSE NULL
                    END AS context,
                    th.type AS a1, th.id::text AS a2, th.direct_agent_id::text AS a3,
                    tm.created_at AS updated_at, ${score(sql`tm.search_vector`, sql`tm.created_at`)} AS score
                FROM thread_messages tm
                JOIN message_threads th ON th.id = tm.thread_id AND th.company_id = ${companyId}::uuid AND th.archived_at IS NULL
                LEFT JOIN agents da ON da.id = th.direct_agent_id
                LEFT JOIN agents sa ON tm.sender_type = 'agent' AND sa.id::text = tm.sender_id AND sa.company_id = ${companyId}::uuid
                LEFT JOIN users su ON tm.sender_type IN ('human', 'user') AND su.id::text = tm.sender_id
                CROSS JOIN q
                WHERE tm.company_id = ${companyId}::uuid AND tm.search_vector @@ q.query
                  AND (
                    th.type = 'team'
                    OR (th.type = 'direct' AND (NOT (th.is_private OR th.owner_user_id IS NOT NULL) OR th.owner_user_id = ${userId}::uuid))
                    OR (th.type = 'group' AND ${viewer.isAdmin ? sql`TRUE` : sql`NOT (th.description IS NOT DISTINCT FROM ${AGENT_PAIR_DESCRIPTION} AND th.created_by_type = 'system')`})
                  )
                  AND (th.direct_agent_id IS NULL OR NOT (th.direct_agent_id = ANY(${unusable})))
                  AND (tm.target_agent_id IS NULL OR NOT (tm.target_agent_id = ANY(${unusable})))
                  AND (tm.sender_type <> 'agent' OR NOT (tm.sender_id = ANY(${unusable}::text[])))
                  ${when(sql`(th.direct_agent_id IS NULL OR th.direct_agent_id = ANY(${agents}))
                    AND (tm.target_agent_id IS NULL OR tm.target_agent_id = ANY(${agents}))
                    AND (tm.sender_type <> 'agent' OR tm.sender_id = ANY(${agents}::text[]))
                    AND (th.type = 'team' OR NOT EXISTS (
                        SELECT 1 FROM thread_participants tp
                        WHERE tp.thread_id = th.id AND tp.participant_type = 'agent'
                          AND (tp.participant_id IS NULL OR NOT (tp.participant_id = ANY(${agents})))
                    ))`)}
                ORDER BY score DESC ${limit})`,
        },
        {
            type: "knowledge",
            sql: sql`(SELECT 'knowledge'::text AS type, sr.id::text AS id, coalesce(nullif(sr.display_name, ''), sr.name) AS title,
                    coalesce(sr.summary, '') || ' ' || sr.config_text AS body,
                    nullif(sr.path, '') AS context, NULL::text AS a1, NULL::text AS a2, NULL::text AS a3,
                    sr.updated_at AS updated_at, ${score(sql`sr.search_vector`, sql`sr.updated_at`)} AS score
                FROM scoped_resources sr
                CROSS JOIN q
                WHERE sr.company_id = ${companyId}::uuid AND sr.deleted_at IS NULL AND sr.search_vector @@ q.query
                  ${when(sql`coalesce(CASE sr.scope_type
                        WHEN 'customer' THEN sr.scope_id = ANY(${customers})
                        WHEN 'project' THEN EXISTS (SELECT 1 FROM projects sp WHERE sp.id = sr.scope_id AND sp.company_id = ${companyId}::uuid AND (sp.customer_id = ANY(${customers}) OR sp.id = ANY(${grantedProjects})))
                        WHEN 'agent' THEN sr.scope_id = ANY(${agents})
                        ELSE TRUE
                    END, FALSE)`)}
                ORDER BY score DESC ${limit})`,
        },
        {
            type: "file",
            sql: sql`(SELECT 'file'::text AS type, a.id::text AS id, coalesce(nullif(a.title, ''), nullif(a.original_filename, ''), nullif(a.path, ''), 'Untitled file') AS title,
                    coalesce(a.content_text, a.preview_text, a.path, '') AS body,
                    p.goal AS context, NULL::text AS a1, NULL::text AS a2, NULL::text AS a3,
                    a.updated_at AS updated_at, ${score(sql`a.search_vector`, sql`a.updated_at`)} AS score
                FROM artifacts a
                LEFT JOIN projects p ON p.id = a.project_id
                CROSS JOIN q
                WHERE a.company_id = ${companyId}::uuid AND a.deleted_at IS NULL AND a.search_vector @@ q.query
                  AND (a.project_id IS NULL OR p.deleted_at IS NULL)
                  ${when(sql`((a.project_id IS NULL AND a.customer_id IS NULL) OR a.customer_id = ANY(${customers}) OR p.customer_id = ANY(${customers}) OR a.project_id = ANY(${grantedProjects}))`)}
                ORDER BY score DESC ${limit})`,
        },
        {
            type: "project",
            sql: sql`(SELECT 'project'::text AS type, p.id::text AS id, p.goal AS title, p.goal AS body,
                    c.name AS context, NULL::text AS a1, NULL::text AS a2, NULL::text AS a3,
                    p.updated_at AS updated_at, ${score(sql`p.search_vector`, sql`p.updated_at`)} AS score
                FROM projects p
                LEFT JOIN customers c ON c.id = p.customer_id
                CROSS JOIN q
                WHERE p.company_id = ${companyId}::uuid AND p.deleted_at IS NULL AND p.search_vector @@ q.query
                  ${when(sql`(p.customer_id = ANY(${customers}) OR p.id = ANY(${grantedProjects}))`)}
                ORDER BY score DESC ${limit})`,
        },
        {
            type: "customer",
            sql: sql`(SELECT 'customer'::text AS type, c.id::text AS id, c.name AS title, coalesce(nullif(c.notes, ''), c.name) AS body,
                    NULL::text AS context, NULL::text AS a1, NULL::text AS a2, NULL::text AS a3,
                    c.created_at AS updated_at, ${score(sql`c.search_vector`, sql`c.created_at`)} AS score
                FROM customers c
                CROSS JOIN q
                WHERE c.company_id = ${companyId}::uuid AND c.deleted_at IS NULL AND c.search_vector @@ q.query
                  ${when(sql`c.id = ANY(${customers})`)}
                ORDER BY score DESC ${limit})`,
        },
        {
            type: "agent",
            sql: sql`(SELECT 'agent'::text AS type, ag.id::text AS id, ag.name AS title, coalesce(nullif(ag.role, ''), ag.name) AS body,
                    ag.role AS context, NULL::text AS a1, NULL::text AS a2, NULL::text AS a3,
                    coalesce(ag.last_seen_at, ag.created_at) AS updated_at, ${score(sql`ag.search_vector`, sql`coalesce(ag.last_seen_at, ag.created_at)`)} AS score
                FROM agents ag
                CROSS JOIN q
                WHERE ag.company_id = ${companyId}::uuid AND ag.deleted_at IS NULL AND ag.search_vector @@ q.query
                  AND NOT (ag.id = ANY(${unlisted}))
                  ${when(sql`ag.id = ANY(${agents})`)}
                ORDER BY score DESC ${limit})`,
        },
    ];
}

type Row = {
    type: SearchType;
    id: string;
    title: string | null;
    context: string | null;
    a1: string | null;
    a2: string | null;
    a3: string | null;
    updated_at: Date | string | null;
    headline: string | null;
};

/** Where a result opens (the same links the palette and pages already use). */
export function searchResultHref(row: Pick<Row, "type" | "id" | "a1" | "a2" | "a3">): string {
    switch (row.type) {
        case "task": return `/projects?project=${encodeURIComponent(row.a1 ?? "")}&task=${encodeURIComponent(row.a2 ?? row.id)}`;
        case "message":
            if (row.a1 === "direct" && row.a2) return directThreadLink(row.a2, row.a3);
            if (row.a1 === "group" && row.a2) return `/messages?group=${encodeURIComponent(row.a2)}`;
            return "/messages";
        case "knowledge": return `/resources?resource=${encodeURIComponent(row.id)}`;
        case "file": return `/artifacts/${encodeURIComponent(row.id)}`;
        case "project": return `/projects?project=${encodeURIComponent(row.id)}`;
        case "customer": return "/customers";
        case "agent": return `/agents?agent=${encodeURIComponent(row.id)}`;
    }
}

function toIso(value: Date | string | null): string {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string") {
        const date = new Date(value.includes("T") || value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`);
        return Number.isNaN(date.getTime()) ? value : date.toISOString();
    }
    return new Date(0).toISOString();
}

/**
 * Ranked results for one page. `nextCursor` is set when another page exists.
 * A query with nothing searchable (too short, only punctuation) returns no
 * results rather than an error.
 */
export async function searchCompany(viewer: SearchViewer, options: SearchOptions): Promise<SearchResponse> {
    const query = options.q.trim();
    const tsQuery = buildTsQuery(query);
    const types = new Set(options.types?.length ? options.types : SEARCH_TYPES);
    if (!tsQuery || types.size === 0) return { query, results: [], nextCursor: null };

    const offset = Math.min(Math.max(options.offset ?? 0, 0), SEARCH_MAX_OFFSET);
    const limit = Math.max(1, options.limit);
    // One extra row says whether another page exists.
    const take = limit + 1;
    const limited = await agentsNotUsableBy({ companyId: viewer.companyId, userId: viewer.userId, role: viewer.isAdmin ? "admin" : "member", scope: viewer.scope });
    const selected = branches(viewer, offset + take, limited).filter((branch) => types.has(branch.type));

    const result = await db.execute(sql`
        WITH q AS (SELECT to_tsquery(${CONFIG}, ${tsQuery}) AS query),
        hits AS (${sql.join(selected.map((branch) => branch.sql), sql` UNION ALL `)}),
        page AS (SELECT * FROM hits ORDER BY score DESC, updated_at DESC, id LIMIT ${take} OFFSET ${offset})
        SELECT page.type, page.id, page.title, page.context, page.a1, page.a2, page.a3, page.updated_at,
            ts_headline(${CONFIG}, left(translate(coalesce(page.body, ''), chr(2) || chr(3), ''), ${HEADLINE_SOURCE_CHARS}), q.query, ${HEADLINE_OPTIONS}) AS headline
        FROM page CROSS JOIN q
        ORDER BY page.score DESC, page.updated_at DESC, page.id
    `);
    const rows = result.rows as unknown as Row[];
    const pageRows = rows.slice(0, limit);
    const results: SearchResult[] = pageRows.map((row) => {
        const { snippet, highlights } = parseHeadline(row.headline);
        return {
            type: row.type,
            id: row.id,
            title: plainText(row.title) || "Untitled",
            snippet,
            highlights,
            href: searchResultHref(row),
            context: row.context ? plainText(row.context, 100) || null : null,
            updatedAt: toIso(row.updated_at),
        };
    });
    const hasMore = rows.length > limit && offset + limit < SEARCH_MAX_OFFSET;
    return { query, results, nextCursor: hasMore ? encodeSearchCursor(offset + limit) : null };
}
