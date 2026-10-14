import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveCompanyBrainContext, listScopedResources, createScopedResource, updateScopedResource, canAgentReadResource, loadAgentResourceAccess, getVisibleKnowledgeNote, searchVisibleKnowledgeNotes, resolveResourceScope, toPublicResource } from "@/lib/resources";
import { EMPEROR_MANUAL, EMPEROR_MANUAL_VERSION, getEmperorManualSection, listEmperorManualSections } from "@/lib/emperor-manual";
import { jsonResult, errorResult } from "../result";

export function registerKnowledgeTools(server: McpServer, companyId: string, callerAgentId?: string | null) {
    server.registerTool("get_knowledge_context", {
        title: "Get Knowledge Context",
        description: "Get this company's resolved Knowledge & Rules context — operating doctrine, SOPs, and business rules, ranked by relevance to the given scope. For the lean model prefer the knowledge index (list_knowledge / search_knowledge) and load a body with get_knowledge_note; use this only when you want the ranked auto-injected bodies in one call.",
        inputSchema: {
            customerId: z.string().optional(),
            projectId: z.string().optional(),
            agentId: z.string().optional(),
            resourceIds: z.array(z.string()).optional().describe("Explicit reference notes to include even if auto-injection is off"),
            tagFilters: z.array(z.string()).optional().describe("Explicit tags to retrieve reference notes"),
            maxChars: z.number().int().optional().describe("Total character budget for returned context (default 12000)"),
        },
    }, async ({ customerId, projectId, agentId, maxChars, resourceIds, tagFilters }) => {
        try {
            const context = await resolveCompanyBrainContext({ companyId, customerId, projectId, agentId, callerAgentId, maxChars, resourceIds, tagFilters });
            return jsonResult(context);
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("list_knowledge", {
        title: "List Knowledge & Rules",
        description: "List Knowledge & Rules notes for this company, optionally filtered by scope.",
        inputSchema: {
            scopeType: z.enum(["company", "customer", "project", "agent"]).optional(),
            scopeId: z.string().optional(),
            search: z.string().optional().describe("Free-text search over name/content"),
        },
    }, async ({ scopeType, scopeId, search }) => {
        try {
            const resources = await listScopedResources({ companyId, scopeType, scopeId, search });
            const access = await loadAgentResourceAccess(companyId, callerAgentId ?? null);
            return jsonResult({
                resources: resources
                    // Index fields only: never the secret or the note body, and
                    // only notes the calling agent is allowed to see.
                    .filter((resource) => canAgentReadResource(resource, access))
                    .map((resource) => ({
                        id: resource.id,
                        name: resource.name,
                        displayName: resource.displayName,
                        scopeType: resource.scopeType,
                        scopeId: resource.scopeId,
                        resourceType: resource.resourceType,
                        status: resource.status,
                        isShared: resource.isShared,
                        path: resource.path,
                        updatedAt: resource.updatedAt,
                        shareUrl: resource.resourceType === "knowledge_base" ? `emperor://knowledge/${resource.id}` : undefined,
                    })),
            });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("create_knowledge_note", {
        title: "Create Knowledge & Rules Note",
        description: "Create a new Knowledge & Rules note — reusable doctrine, an SOP, or a business rule. Use an Obsidian-style markdown note with frontmatter (scope/type/status/owner/tags) as content. Pick the smallest correct scope; do not create a note for one-off facts.",
        inputSchema: {
            name: z.string().min(1).describe("Short unique note name"),
            content: z.string().describe("Markdown content, ideally with frontmatter (scope/type/status/owner/tags)"),
            scopeType: z.enum(["company", "customer", "project", "agent"]).default("company"),
            scopeId: z.string().optional().describe("Required unless scopeType is 'company'"),
            status: z.enum(["active", "draft"]).optional().describe("Publication state: established facts active, uncertain proposals draft; frontmatter alone does not set this"),
            isShared: z.boolean().optional().describe("Auto-inject this active note in matching agent contexts (default false); not an access-control setting"),
        },
    }, async ({ name, content, scopeType, scopeId, isShared, status }) => {
        try {
            const resource = await createScopedResource({
                companyId, name, scopeType, scopeId,
                provider: "knowledge", resourceType: "knowledge_base",
                configText: content, isShared, status,
            });
            return jsonResult({ message: "Knowledge note created", resource: toPublicResource(resource) });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("update_knowledge_note", {
        title: "Update Knowledge & Rules Note",
        description: "Update an existing Knowledge & Rules note's content, name, or sharing status.",
        inputSchema: {
            resourceId: z.string(),
            content: z.string().optional(),
            name: z.string().optional(),
            status: z.enum(["active", "draft"]).optional().describe("Publication state: established facts active, uncertain proposals draft; frontmatter alone does not set this"),
            isShared: z.boolean().optional(),
        },
    }, async ({ resourceId, content, name, isShared, status }) => {
        try {
            const resource = await updateScopedResource({
                companyId, resourceId,
                patch: { configText: content, name, isShared, status },
            });
            return jsonResult({ message: "Knowledge note updated", resource: resource ? toPublicResource(resource) : resource });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("get_emperor_manual", {
        title: "Get Emperor Manual",
        description: "The single Emperor manual: how Emperor works (chat and mentions, tasks and projects, knowledge and injection modes, storage, approvals, team handoffs, reply formatting). Omit section for the whole manual plus the section list; pass a section id for just that section.",
        inputSchema: {
            section: z.string().optional().describe("Section id, e.g. chat-and-mentions, approvals, reply-formatting"),
        },
    }, async ({ section }) => {
        try {
            if (section) {
                const found = getEmperorManualSection(section);
                if (!found) {
                    return errorResult(new Error(`Unknown section: ${section}. Sections: ${listEmperorManualSections().map((item) => item.id).join(", ")}`));
                }
                return jsonResult({ version: EMPEROR_MANUAL_VERSION, section: found });
            }
            return jsonResult({ version: EMPEROR_MANUAL_VERSION, sections: listEmperorManualSections(), manual: EMPEROR_MANUAL });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("get_knowledge_note", {
        title: "Get Knowledge Note",
        description: "Load one full Knowledge & Rules note by id, scope-checked and with secrets excluded. Use this to open the body behind a line in the knowledge index.",
        inputSchema: {
            id: z.string().describe("Knowledge note resource id"),
        },
    }, async ({ id }) => {
        try {
            const resource = await getVisibleKnowledgeNote({ companyId, resourceId: id, agentId: callerAgentId ?? null });
            if (!resource) return errorResult(new Error("Knowledge note not found or outside your scope"));
            return jsonResult({ resource: { ...toPublicResource(resource), ...resolveResourceScope(resource) } });
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("search_knowledge", {
        title: "Search Knowledge",
        description: "Search this company's Knowledge & Rules by name, summary, or content and get matching index lines (title — summary — id). Open a result with get_knowledge_note. At most 20 results.",
        inputSchema: {
            query: z.string().min(1).describe("Free-text search over name, summary, and content"),
            limit: z.number().int().min(1).max(20).optional().describe("Maximum results (default 10, max 20)"),
        },
    }, async ({ query, limit }) => {
        try {
            const results = await searchVisibleKnowledgeNotes({ companyId, query, agentId: callerAgentId ?? null, limit });
            return jsonResult({ query, count: results.length, results });
        } catch (e) {
            return errorResult(e);
        }
    });
}
