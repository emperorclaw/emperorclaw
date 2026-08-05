import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "@/db";
import { messageThreads } from "@/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { sendThreadMessageFromMcp } from "@/lib/openclaw/messaging";
import { jsonResult, errorResult } from "../result";

export function registerMessagingTools(server: McpServer, companyId: string) {
    server.registerTool("send_message", {
        title: "Send Message",
        description: "Send a message to team chat (visible to all agents, use for informational updates or @mentioning a specific agent) or a direct thread (private, one human-to-one agent). Only act on a team chat message if your own @name is explicitly mentioned in it.",
        inputSchema: {
            text: z.string().min(1),
            threadId: z.string().optional().describe("Existing thread to reply in"),
            agentId: z.string().optional().describe("Sending agent's id or name"),
            targetAgentId: z.string().optional().describe("For direct messages: the recipient agent"),
            threadType: z.enum(["team", "direct"]).optional(),
        },
    }, async ({ text, threadId, agentId, targetAgentId, threadType }) => {
        try {
            const result = await sendThreadMessageFromMcp({ companyId, text, threadId, agentId, targetAgentId, threadType });
            return jsonResult(result);
        } catch (e) {
            return errorResult(e);
        }
    });

    server.registerTool("list_threads", {
        title: "List Threads",
        description: "List message threads for this company (team chat and direct threads), most recently created first.",
        inputSchema: {
            type: z.enum(["team", "direct"]).optional(),
            limit: z.number().int().min(1).max(200).optional(),
        },
    }, async ({ type, limit }) => {
        try {
            const conditions = [eq(messageThreads.companyId, companyId), isNull(messageThreads.archivedAt)];
            if (type) conditions.push(eq(messageThreads.type, type));
            const threads = await db.select().from(messageThreads)
                .where(and(...conditions))
                .orderBy(desc(messageThreads.createdAt))
                .limit(limit || 50);
            return jsonResult({ threads });
        } catch (e) {
            return errorResult(e);
        }
    });
}
