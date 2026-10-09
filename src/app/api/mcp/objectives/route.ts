import { NextRequest, NextResponse } from 'next/server';
import { verifyMcpToken, resolveBoundAgentId } from '@/lib/mcp';
import { listAgentObjectives, updateObjectiveFromAgent, readAgentObjective } from '@/lib/agent-objective';

/**
 * Runtime objective transport. A token bound to an agent can only read or
 * update that agent's own objectives; `resolveBoundAgentId` refuses a
 * mismatched agentId, and the service re-checks ownership by (company, agent).
 */
async function actor(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) throw new Error(auth.error);
    const companyId = auth.companyToken!.companyId;
    const agentId = await resolveBoundAgentId(companyId, auth.companyToken!, new URL(req.url).searchParams.get('agentId'));
    if (!agentId) throw new Error('Agent required');
    return { companyId, agentId };
}

const ACTIONS = ['update', 'pause', 'resume', 'block', 'complete', 'cancel'] as const;
type Action = (typeof ACTIONS)[number];

export async function GET(req: NextRequest) {
    try {
        const { companyId, agentId } = await actor(req);
        const { objective } = await readAgentObjective(companyId, agentId);
        const objectives = await listAgentObjectives(companyId, agentId);
        return NextResponse.json({ objective, objectives });
    } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : 'Objective read failed' }, { status: 403 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const { companyId, agentId } = await actor(req);
        const body = await req.json();
        if (typeof body.objectiveId !== 'string' || !ACTIONS.includes(body.action)) {
            return NextResponse.json({ error: 'objectiveId and a valid action are required' }, { status: 400 });
        }
        const objective = await updateObjectiveFromAgent(companyId, agentId, {
            objectiveId: body.objectiveId,
            action: body.action as Action,
            summary: typeof body.summary === 'string' ? body.summary : null,
            blockerReason: typeof body.blockerReason === 'string' ? body.blockerReason : null,
            completionSummary: typeof body.completionSummary === 'string' ? body.completionSummary : null,
            objective: typeof body.objective === 'string' ? body.objective : null,
            cadenceMinutes: body.cadenceMinutes != null ? Number(body.cadenceMinutes) : null,
        });
        return NextResponse.json({ ok: true, objective });
    } catch (e) {
        const message = e instanceof Error ? e.message : 'Objective update failed';
        const status = message.startsWith('Access denied') ? 403 : message === 'Objective not found' ? 404 : 400;
        return NextResponse.json({ error: message }, { status });
    }
}
