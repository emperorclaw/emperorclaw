import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveCompanyBrainContext, listScopedResources, createScopedResource, updateScopedResource, canAgentReadResource, loadAgentResourceAccess, getVisibleKnowledgeNote, searchVisibleKnowledgeNotes, resolveResourceScope, toPublicResource } from "@/lib/resources";
import { EMPEROR_MANUAL, EMPEROR_MANUAL_VERSION, getEmperorManualSection, listEmperorManualSections } from "@/lib/emperor-manual";
import { jsonResult, errorResult } from "../result";
import { getScopedResource } from "@/lib/resources";
import { mcpAccessForAgent, mcpMayUseResource, mcpMayWriteResourceScope, type McpAgentAccess } from "@/lib/mcp-access";
import { agentMayUseKnowledgeFolder, filterNotesInUsableFolders, listKnowledgeFolders, parseKnowledgeFolder, resolveMovedKnowledgeNoteFolder, resolveNewKnowledgeNoteFolder } from "@/lib/knowledge-folders";

/** Shared wording so every knowledge tool teaches the same filing rule. */
const FOLDER_DESCRIPTION = 'Folder path to file the note in, e.g. "Customers/Harbor Dental/Meetings"; missing folders are created. Call list_knowledge_folders first when unsure and reuse the existing convention (Company, Agents, Projects/<project>, Customers/<customer>). "" or "/" is the vault root.';

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
        description: "List Knowledge & Rules notes for this company, optionally filtered by scope or folder. Each note's `path` is its folder (\"\" = vault root).",
        inputSchema: {
            scopeType: z.enum(["company", "customer", "project", "agent"]).optional(),
            scopeId: z.string().optional(),
            search: z.string().optional().describe("Free-text search over name/content"),
            folder: z.string().optional().describe('Only notes in this folder, e.g. "Customers/Harbor Dental" (see list_knowledge_folders)'),
            recursive: z.boolean().optional().describe("With folder: include its subfolders (default true)"),
        },
    }, async ({ scopeType, scopeId, search, folder, recursive }) => {
        try {
            let folderFilter: { path?: string; pathPrefix?: string } = {};
            let folderAccess: McpAgentAccess | null = null;
            if (folder !== undefined) {
                const path = parseKnowledgeFolder(folder);
                folderAccess = await mcpAccessForAgent(companyId, callerAgentId ?? null);
                // An off-limits folder matches nothing, exactly like a missing one.
                if (!(await agentMayUseKnowledgeFolder(companyId, folderAccess, path))) return jsonResult({ resources: [] });
                folderFilter = recursive === false ? { path } : { pathPrefix: path };
            }
            const matched = await listScopedResources({ companyId, scopeType, scopeId, search, ...folderFilter });
            const resources = folderAccess ? await filterNotesInUsableFolders(companyId, folderAccess, matched) : matched;
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

    server.registerTool("list_knowledge_folders", {
        title: "List Knowledge Folders",
        description: "The Knowledge & Rules folder tree you can see, with note counts per folder (directCount) and per subtree (totalCount). Call it before creating or moving a note when you are unsure where it belongs, and file into the existing folder instead of inventing a parallel one.",
        inputSchema: {},
    }, async () => {
        try {
            return jsonResult(await listKnowledgeFolders(companyId, await mcpAccessForAgent(companyId, callerAgentId ?? null)));
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("create_knowledge_note", {
        title: "Create Knowledge & Rules Note",
        description: "Create a new Knowledge & Rules note — reusable doctrine, an SOP, or a business rule. Use an Obsidian-style markdown note with frontmatter (scope/type/status/owner/tags) as content. Pick the smallest correct scope, then the right folder (call list_knowledge_folders when unsure). Without a folder, a customer/project note goes to that customer's/project's folder when the vault uses Customers/ or Projects/, otherwise the vault root. Do not create a note for one-off facts.",
        inputSchema: {
            name: z.string().min(1).describe("Short unique note name"),
            content: z.string().describe("Markdown content, ideally with frontmatter (scope/type/status/owner/tags)"),
            scopeType: z.enum(["company", "customer", "project", "agent"]).default("company"),
            scopeId: z.string().optional().describe("Required unless scopeType is 'company'"),
            status: z.enum(["active", "draft"]).optional().describe("Publication state: established facts active, uncertain proposals draft; frontmatter alone does not set this"),
            isShared: z.boolean().optional().describe("Auto-inject this active note in matching agent contexts (default false); not an access-control setting"),
            folder: z.string().optional().describe(FOLDER_DESCRIPTION),
        },
    }, async ({ name, content, scopeType, scopeId, isShared, status, folder }) => {
        try {
            const access = await mcpAccessForAgent(companyId, callerAgentId ?? null);
            if (!mcpMayWriteResourceScope(access, scopeType, scopeId)) {
                throw new Error("That scope is outside your scope");
            }
            const path = await resolveNewKnowledgeNoteFolder({ companyId, access, folder, scopeType, scopeId });
            const resource = await createScopedResource({
                companyId, name, scopeType, scopeId, path,
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
        description: "Update an existing Knowledge & Rules note's content, name, sharing status, or folder. Pass folder to move a misfiled note (missing folders are created; \"\" moves it to the vault root).",
        inputSchema: {
            resourceId: z.string(),
            content: z.string().optional(),
            name: z.string().optional(),
            status: z.enum(["active", "draft"]).optional().describe("Publication state: established facts active, uncertain proposals draft; frontmatter alone does not set this"),
            isShared: z.boolean().optional(),
            folder: z.string().optional().describe(`Move the note here. ${FOLDER_DESCRIPTION}`),
        },
    }, async ({ resourceId, content, name, isShared, status, folder }) => {
        try {
            // Only notes this agent may read can be edited (same rule as get_knowledge_note).
            const access = await mcpAccessForAgent(companyId, callerAgentId ?? null);
            const existing = await getScopedResource(companyId, resourceId);
            if (existing && !mcpMayUseResource(access, existing)) {
                throw new Error("Knowledge note not found or outside your scope");
            }
            const path = existing ? await resolveMovedKnowledgeNoteFolder({ companyId, access, folder }) : undefined;
            const resource = await updateScopedResource({
                companyId, resourceId,
                patch: { configText: content, name, isShared, status, path },
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
