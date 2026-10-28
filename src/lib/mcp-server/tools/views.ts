import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonResult, errorResult } from "../result";
import { mcpAccessForAgent } from "@/lib/mcp-access";
import { mcpActor } from "@/lib/audit";
import { createView, getView, listViews, setViewArchived, updatePanel, updateView, type ViewCaller } from "@/lib/views";
import { VIEW_MAX_PANELS, VIEW_SCOPE_TYPES } from "@/lib/view-spec";
import { AGENT_VIEW_VISIBILITIES, VIEW_REFRESH_MAX_MINUTES } from "@/lib/view-access";

/** The panel format, taught once and shared by create_view and update_view. */
export const VIEW_PANELS_DESCRIPTION = [
    `Panels in reading order on a 12-column grid (at most ${VIEW_MAX_PANELS}). Each panel: {id?, type, title, subtitle?, w?, h?, data?}.`,
    "id: short stable slug you reuse with update_panel (derived from the title when omitted). w: 1-12 columns, h: 1-8 rows (sensible defaults per type). On a phone panels stack.",
    "data by type (all plain text, no HTML; numbers must be finite):",
    "metric {value: number|string, unit?, delta?: number, deltaLabel? e.g. \"vs last week\", trend?: \"up\"|\"down\"|\"flat\" or a number[] sparkline, goodDirection?: \"up\"|\"down\"}.",
    "line | bar {series: [{name, points: [{x: string|number, y: number}]}] (≤12 series, ≤500 points each), xLabel?, yLabel?, unit?, stacked?}.",
    "table {columns: [{key, label, align?: left|right|center, format?: text|number|integer|percent|currency|date, currency?: \"EUR\"}], rows: [{<key>: string|number|boolean|null}] (≤500 rows)}.",
    "list {items: [{title, subtitle?, value?, href?}] (≤200; href is an https URL or an app path like /projects)}.",
    "markdown {text} (≤20,000 chars; no HTML and no images; links only to https URLs or app paths like /projects). progress {value, max, label?, unit?}.",
].join(" ");

const panelInput = z.object({
    id: z.string().optional().describe("Stable panel id (slug); reuse it with update_panel"),
    type: z.enum(["metric", "line", "bar", "table", "list", "markdown", "progress"]),
    title: z.string().describe("Panel heading"),
    subtitle: z.string().optional(),
    w: z.number().int().optional().describe("Width in grid columns, 1-12"),
    h: z.number().int().optional().describe("Height in rows, 1-8"),
    data: z.record(z.string(), z.unknown()).optional().describe("The panel's values; shape depends on type (see panels)"),
});

/**
 * View tools: an agent builds a dashboard page from typed panels and keeps its
 * numbers fresh. Scope is the knowledge-note rule (lib/views.ts): views of a
 * customer or project outside the agent's scope do not exist for it. Inside
 * it, an agent sees the views open to the scope plus the private/shared views
 * it maintains (lib/view-access.ts), and changes only the views it built.
 */
export function registerViewTools(server: McpServer, companyId: string, callerAgentId?: string | null, tokenId: string | null = null) {
    const caller = async (): Promise<ViewCaller> => ({
        kind: "agent",
        access: await mcpAccessForAgent(companyId, callerAgentId ?? null),
        actor: mcpActor(callerAgentId, tokenId),
    });

    server.registerTool("list_views", {
        title: "List Views",
        description: "List the views (dashboards) you can see: title, scope, visibility, owner, panel count, who built each one, and when their values were last updated. You see views open to your scope and the private views you maintain. Check here before creating a view so you update one of your own instead of building a duplicate (you can only change views you built; createdBy shows the builder).",
        inputSchema: {
            scopeType: z.enum(VIEW_SCOPE_TYPES).optional(),
            scopeId: z.string().optional().describe("Customer or project id, with scopeType"),
            includeArchived: z.boolean().optional(),
        },
    }, async ({ scopeType, scopeId, includeArchived }) => {
        try {
            const views = await listViews(companyId, await caller(), { scopeType, scopeId, includeArchived });
            return jsonResult({ count: views.length, views });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("get_view", {
        title: "Get View",
        description: "Load one view: its layout, every panel's current values, and when and by whom each panel was last updated. Use it before refreshing a view so you know its panel ids and types.",
        inputSchema: {
            viewId: z.string(),
        },
    }, async ({ viewId }) => {
        try {
            return jsonResult({ view: await getView(companyId, await caller(), viewId) });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("create_view", {
        title: "Create View",
        description: [
            "Build a view: a dashboard page in Emperor made of typed panels (metrics, line/bar charts, tables, lists, markdown, progress bars) that people open from the Views menu or pin to Home.",
            "Use it when someone asks for a dashboard, report page, tracker or \"a view of …\" (e.g. \"Build me a view of this month's e-shop products\"), or when numbers you report repeatedly deserve a page.",
            "You fetch the numbers from your own tools and credentials (shop, analytics, bank); Emperor stores only the values you push. Never put secrets or credentials in a view.",
            "Pick the smallest correct scope: company, or a customer/project id for client- or project-specific numbers.",
            "You become the view's maintainer: only you (and people) can change it later. A company holds at most 200 active views.",
            "Pass threadId (the conversation you were asked in): the person whose private chat it is becomes the view's owner and the view is private to them by default; in a team or group chat the view is open to everyone in its scope unless you name ownerUserId (a person from that conversation) and visibility \"private\".",
            "Never repeat a private view's numbers in team or group chats.",
            "Set refreshEveryMinutes to how often you will refresh it (e.g. 60 for hourly), so people see when it is overdue.",
            "After creating it, keep it fresh: refresh the values with update_panel on a schedule with your own cron/routine (e.g. hourly or daily, matching how fast the numbers change), and whenever someone asks you to refresh it.",
        ].join(" "),
        inputSchema: {
            title: z.string().describe("Short page title, e.g. \"Products this month\""),
            description: z.string().optional().describe("One or two sentences: what the view shows, the data source and how often you refresh it"),
            scopeType: z.enum(VIEW_SCOPE_TYPES).optional().describe("Default company"),
            scopeId: z.string().optional().describe("Customer or project id; required for a customer or project view"),
            panels: z.array(panelInput).max(VIEW_MAX_PANELS).describe(VIEW_PANELS_DESCRIPTION),
            threadId: z.string().optional().describe("The thread you were asked in; its person becomes the owner when it is their private chat with you"),
            ownerUserId: z.string().optional().describe("The person the view is for; must be someone from threadId's conversation"),
            visibility: z.enum(AGENT_VIEW_VISIBILITIES).optional().describe("private (owner only) or scope (everyone who can see the scope). Default: private in a private chat, else scope. Sharing with specific people is done by a person in Emperor."),
            refreshEveryMinutes: z.number().int().min(1).max(VIEW_REFRESH_MAX_MINUTES).optional().describe("How often you refresh the values, in minutes (60 = hourly, 1440 = daily)"),
        },
    }, async ({ title, description, scopeType, scopeId, panels, threadId, ownerUserId, visibility, refreshEveryMinutes }) => {
        try {
            const view = await createView(companyId, await caller(), { title, description, scopeType, scopeId, panels, threadId, ownerUserId, visibility, refreshEveryMinutes });
            return jsonResult({ message: "View created. Keep it fresh with update_panel on a schedule.", url: `/views/${view.id}`, view });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("update_view", {
        title: "Update View",
        description: "Change a view's title, description, refresh interval (refreshEveryMinutes) or layout (add, remove, reorder or resize panels). Who can see a view is not changed here: its owner does that in Emperor. Only for views you built; another agent's view is refused (ask a person or that agent). Passing panels replaces the whole layout, so send every panel you want to keep (with their ids); panels you send with data also get those values. Each title or layout change saves a new version people can revert. To refresh numbers only, use update_panel instead.",
        inputSchema: {
            viewId: z.string(),
            title: z.string().optional(),
            description: z.string().optional(),
            panels: z.array(panelInput).max(VIEW_MAX_PANELS).optional().describe(VIEW_PANELS_DESCRIPTION),
            refreshEveryMinutes: z.number().int().min(0).max(VIEW_REFRESH_MAX_MINUTES).nullable().optional().describe("How often you refresh the values, in minutes; null or 0 clears it"),
        },
    }, async ({ viewId, title, description, panels, refreshEveryMinutes }) => {
        try {
            const view = await updateView(companyId, await caller(), viewId, { title, description, panels, refreshEveryMinutes });
            return jsonResult({ message: "View updated", view });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("update_panel", {
        title: "Update View Panel",
        description: "Replace one panel's values with a fresh snapshot (the layout is untouched and no version is created). This is how you keep a view up to date: call it once per panel on your refresh schedule, and when someone asks you to refresh the view. Only for views you built; at most 60 updates per view per minute. The data must match the panel's type (see create_view); get_view lists the panel ids and types. Each panel shows \"Updated <time> by <you>\".",
        inputSchema: {
            viewId: z.string(),
            panelId: z.string(),
            data: z.record(z.string(), z.unknown()).describe("The panel's full new values"),
        },
    }, async ({ viewId, panelId, data }) => {
        try {
            const panel = await updatePanel(companyId, await caller(), viewId, panelId, data);
            return jsonResult({ message: "Panel updated", panel: { id: panel.id, type: panel.type, updatedAt: panel.updatedAt } });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("archive_view", {
        title: "Archive View",
        description: "Archive a view you built that is no longer needed (it leaves the Views list and Home; a person can restore it). Stop your refresh schedule for it too.",
        inputSchema: {
            viewId: z.string(),
        },
    }, async ({ viewId }) => {
        try {
            const result = await setViewArchived(companyId, await caller(), viewId, true);
            return jsonResult({ message: "View archived", ...result });
        } catch (e) {
            return errorResult(e);
        }
    });
}
