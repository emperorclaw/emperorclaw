import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveCompanyBrainContext, listScopedResources, createScopedResource, updateScopedResource } from "@/lib/resources";
import { jsonResult, errorResult } from "../result";

export function registerKnowledgeTools(server: McpServer, companyId: string) {
    server.registerTool("get_knowledge_context", {
        title: "Get Knowledge Context",
        description: "Get this company's resolved Knowledge & Rules context — operating doctrine, SOPs, and business rules, ranked by relevance to the given scope. Call this before assuming any business convention.",
        inputSchema: {
            customerId: z.string().optional(),
            projectId: z.string().optional(),
            agentId: z.string().optional(),
            maxChars: z.number().int().optional().describe("Total character budget for returned context (default 12000)"),
        },
    }, async ({ customerId, projectId, agentId, maxChars }) => {
        try {
            const context = await resolveCompanyBrainContext({ companyId, customerId, projectId, agentId, maxChars });
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
            return jsonResult({ resources });
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
            isShared: z.boolean().optional().describe("Whether other agents can read this note (default false)"),
        },
    }, async ({ name, content, scopeType, scopeId, isShared }) => {
        try {
            const resource = await createScopedResource({
                companyId, name, scopeType, scopeId,
                provider: "knowledge", resourceType: "knowledge_base",
                configText: content, isShared,
            });
            return jsonResult({ message: "Knowledge note created", resource });
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
            isShared: z.boolean().optional(),
        },
    }, async ({ resourceId, content, name, isShared }) => {
        try {
            const resource = await updateScopedResource({
                companyId, resourceId,
                patch: { configText: content, name, isShared },
            });
            return jsonResult({ message: "Knowledge note updated", resource });
        } catch (e) {
            return errorResult(e);
        }
    });
}
