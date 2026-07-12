import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { db } from "@/db";
import { agents, projects, tasks, customers, companies } from "@/db/schema";
import { and, eq, count, isNull } from "drizzle-orm";

type JsonRpcId = string | number | null;

interface JsonRpcEnvelope {
    jsonrpc: "2.0";
    id: JsonRpcId;
    method: string;
    params?: JsonRpcParams;
}

interface JsonRpcParams {
    id?: string;
    name?: string;
    role?: string;
    goal?: string;
    model?: string;
    skills?: string[];
    skillsJson?: string[];
    [key: string]: unknown;
}

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if ("error" in auth) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }
    const companyId = auth.companyToken.companyId;

    try {
        const body = (await req.json()) as JsonRpcEnvelope;

        // Handle JSON-RPC Standard Requests from OpenClaw's native engine
        if (body.jsonrpc === "2.0") {
            const { id, method, params = {} } = body;

            if (method === "status.summary") {
                const [agentsCount] = await db.select({ value: count() }).from(agents).where(eq(agents.companyId, companyId));
                const [projectsCount] = await db.select({ value: count() }).from(projects).where(eq(projects.companyId, companyId));
                const [tasksCount] = await db.select({ value: count() }).from(tasks).where(eq(tasks.companyId, companyId));

                const [comp] = await db.select({ contextNotes: companies.contextNotes }).from(companies).where(eq(companies.id, companyId));

                return NextResponse.json({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        agents: agentsCount.value,
                        projects: projectsCount.value,
                        tasks: tasksCount.value,
                        status: "online",
                        contextNotes: comp?.contextNotes || null
                    }
                });
            }

            if (method === "agents.upsert") {
                // Upsert OpenClaw's agent state natively
                // params: { id: "probe-agent", name: "Probe", role: "test", model: "openai/gpt-5-mini" }
                // In Emperor Claw, we have our own UUID IDs, but we can store their native ID in the name or just create it if it doesn't match
                // For simplicity, we'll just insert a new agent or ignore if we want to map it
                const agentName =
                    typeof params.name === "string" && params.name.trim()
                        ? params.name.trim()
                        : typeof params.id === "string" && params.id.trim()
                            ? params.id.trim()
                            : "OpenClaw Agent";
                const agentSkills =
                    Array.isArray(params.skills) ? params.skills :
                    Array.isArray(params.skillsJson) ? params.skillsJson :
                    [];

                // Real upsert keyed on (companyId, name); DB failures surface
                // as JSON-RPC errors instead of duplicate rows reported as success.
                try {
                    const [existingAgent] = await db.select({ id: agents.id }).from(agents).where(
                        and(eq(agents.companyId, companyId), eq(agents.name, agentName), isNull(agents.deletedAt))
                    ).limit(1);

                    if (existingAgent) {
                        await db.update(agents).set({
                            role: params.role || "operator",
                            skillsJson: agentSkills,
                            status: "online",
                            lastSeenAt: new Date(),
                        }).where(eq(agents.id, existingAgent.id));
                    } else {
                        await db.insert(agents).values({
                            companyId,
                            name: agentName,
                            role: params.role || "operator",
                            skillsJson: agentSkills,
                            status: "online",
                            lastSeenAt: new Date(),
                            currentLoad: 0,
                        });
                    }
                } catch (upsertError) {
                    const message = upsertError instanceof Error ? upsertError.message : "Agent upsert failed";
                    return NextResponse.json({
                        jsonrpc: "2.0",
                        id,
                        error: { code: -32000, message }
                    });
                }

                return NextResponse.json({
                    jsonrpc: "2.0",
                    id,
                    result: { success: true, synced_id: params.id }
                });
            }

            if (method === "projects.upsert") {
                const projectGoal =
                    typeof params.goal === "string" && params.goal.trim()
                        ? params.goal.trim()
                        : typeof params.name === "string" && params.name.trim()
                            ? params.name.trim()
                            : "OpenClaw Project";

                try {
                    const [existingProject] = await db.select({ id: projects.id }).from(projects).where(
                        and(eq(projects.companyId, companyId), eq(projects.goal, projectGoal), isNull(projects.deletedAt))
                    ).limit(1);

                    if (!existingProject) {
                        await db.insert(projects).values({
                            companyId,
                            goal: projectGoal,
                            status: "active",
                        });
                    }
                } catch (projectError) {
                    const message = projectError instanceof Error ? projectError.message : "Project upsert failed";
                    return NextResponse.json({
                        jsonrpc: "2.0",
                        id,
                        error: { code: -32000, message }
                    });
                }

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

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: "Internal Server Error", message }, { status: 500 });
    }
}
