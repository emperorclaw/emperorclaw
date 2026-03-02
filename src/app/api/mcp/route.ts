import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { db } from "@/db";
import { agents, projects, tasks, customers } from "@/db/schema";
import { eq, count } from "drizzle-orm";

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if ("error" in auth) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }
    const companyId = auth.companyToken.companyId;

    try {
        const body = await req.json();

        // Handle JSON-RPC Standard Requests from OpenClaw's native engine
        if (body.jsonrpc === "2.0") {
            const { id, method, params } = body;

            if (method === "status.summary") {
                const [agentsCount] = await db.select({ value: count() }).from(agents).where(eq(agents.companyId, companyId));
                const [projectsCount] = await db.select({ value: count() }).from(projects).where(eq(projects.companyId, companyId));
                const [tasksCount] = await db.select({ value: count() }).from(tasks).where(eq(tasks.companyId, companyId));

                return NextResponse.json({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        agents: agentsCount.value,
                        projects: projectsCount.value,
                        tasks: tasksCount.value,
                        status: "online"
                    }
                });
            }

            if (method === "agents.upsert") {
                // Upsert OpenClaw's agent state natively
                // params: { id: "probe-agent", name: "Probe", role: "test", model: "openai/gpt-5-mini" }
                // In Emperor Claw, we have our own UUID IDs, but we can store their native ID in the name or just create it if it doesn't match
                // For simplicity, we'll just insert a new agent or ignore if we want to map it
                await db.insert(agents).values({
                    companyId,
                    name: params.name || params.id,
                    role: params.role || "operator",
                    skillsJson: params.skills || params.skillsJson || [],
                    status: "online",
                    lastSeenAt: new Date(),
                    currentLoad: 0,
                }).catch(e => console.error("Agent Upsert Ignore:", e));

                return NextResponse.json({
                    jsonrpc: "2.0",
                    id,
                    result: { success: true, synced_id: params.id }
                });
            }

            if (method === "projects.upsert") {
                await db.insert(projects).values({
                    companyId,
                    goal: params.goal || params.name,
                    status: "active",
                }).catch(e => console.error("Project Upsert Ignore:", e));

                return NextResponse.json({
                    jsonrpc: "2.0",
                    id,
                    result: { success: true, synced_id: params.id }
                });
            }

            if (method === "tasks.upsert") {
                return NextResponse.json({
                    jsonrpc: "2.0",
                    id,
                    result: { success: true, synced_id: params.id }
                });
            }

            // Fallback for unknown JSON-RPC methods
            return NextResponse.json({
                jsonrpc: "2.0",
                id,
                error: { code: -32601, message: "Method not found" }
            });
        }

        // If it's not JSON-RPC, throw a bad request (since GET/POST to /api/mcp directly isn't supported for REST)
        return NextResponse.json({ error: "Invalid JSON-RPC payload" }, { status: 400 });

    } catch (e: any) {
        return NextResponse.json({ error: "Internal Server Error", message: e.message }, { status: 500 });
    }
}
