import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EXTERNAL_ACTION_KEYS } from "@/lib/action-policy";
import { checkExternalAction } from "@/lib/action-policy-server";
import { resolveAgentId } from "@/lib/mcp";
import { jsonResult, errorResult } from "../result";

export function registerActionPolicyTools(server: McpServer, companyId: string, callerAgentId?: string | null, tokenId: string | null = null) {
    server.registerTool("check_action", {
        title: "Check Action",
        description: "Call this BEFORE you do one of these with your own tools (outside Emperor): send_email, post_social, spend_money, delete_data, deploy, browse_web, run_shell. Pass what exactly you are about to do in details (recipients, subject, amount, target, command...). The answer: mayProceed true = go ahead, once, exactly as described. decision approval_pending = a person must approve first; nothing is allowed yet; when you are told it is approved, call check_action again with the same details and act only if mayProceed is true. off or refused = do NOT do it and don't work around it.",
        inputSchema: {
            action: z.enum(EXTERNAL_ACTION_KEYS as [string, ...string[]]).describe("The kind of action"),
            details: z.record(z.string(), z.unknown()).describe("What you are about to do, e.g. { to, subject } for an email or { amount, currency, vendor } for a purchase. Use the same details when you check again after approval."),
            agentId: z.string().optional().describe("Acting agent's id or name (operator connections only)"),
        },
    }, async ({ action, details, agentId }) => {
        try {
            const agent = callerAgentId ?? (agentId ? await resolveAgentId(companyId, agentId) : null);
            return jsonResult(await checkExternalAction({ companyId, agentId: agent, tokenId, action, details }));
        } catch (e) {
            return errorResult(e);
        }
    });
}
