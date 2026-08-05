import { NextRequest } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { verifyMcpToken } from "@/lib/mcp";
import { buildMcpServer } from "@/lib/mcp-server";

// The real, spec-compliant MCP endpoint (initialize/tools/list/tools/call) —
// distinct from the legacy bespoke JSON-RPC sync endpoint at /api/mcp, and
// from the plain REST API under /api/mcp/**. Point Claude Desktop/Codex/any
// MCP client here with `Authorization: Bearer <company token>`.
//
// Stateless: a fresh McpServer + transport is built per request
// (sessionIdGenerator left unset). Every tool here is a self-contained DB
// CRUD call — no server-push/subscriptions — so there's no session state
// worth keeping across requests, and this sidesteps in-memory session
// bookkeeping surviving Docker restarts.
function unauthorized(message: string, status: number) {
    return Response.json(
        { jsonrpc: "2.0", error: { code: -32001, message }, id: null },
        { status },
    );
}

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return unauthorized(auth.error, auth.status);
    }

    const companyId = auth.companyToken!.companyId;

    try {
        const server = await buildMcpServer(companyId);
        const transport = new WebStandardStreamableHTTPServerTransport();
        await server.connect(transport);
        return await transport.handleRequest(req);
    } catch (error) {
        console.error("MCP request handling error:", error);
        return Response.json(
            { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null },
            { status: 500 },
        );
    }
}

function methodNotAllowed() {
    return Response.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
        { status: 405 },
    );
}

export async function GET() {
    return methodNotAllowed();
}

export async function DELETE() {
    return methodNotAllowed();
}
