import { db } from '@/db';
import { agents, threadMessages } from '@/db/schema';
import { and, eq, isNull, sql, desc } from 'drizzle-orm';
import { ensureDirectThread, appendThreadMessage } from '@/lib/control-plane';
import { isCompanyOwnerOrAdmin } from '@/lib/groups';
import { broadcastMcpEvent } from '@/lib/pubsub';
export type GoalAction = 'start' | 'pause' | 'resume' | 'clear';
export function parseGoalCommand(text: string) {
    const match = text.trim().match(/^\/goal(?:\s+([\s\S]*))?$/i);
    if (!match) return null;
    const value = (match[1] || '').trim();
    if (/^--\s+/.test(value)) return {action:'start' as const,objective:value.replace(/^--\s+/, '')};
    if (/^(draft|gate|wait|unwait|subgoal)(?:\s|$)/i.test(value)) return {action:'unsupported' as const,objective:''};
    if (!value || /^(status|show)(?:\s|$)/i.test(value)) return { action: 'status' as const, objective: '' };
    if (/^(pause|resume|clear)(?:\s|$)/i.test(value)) return { action: value.split(/\s/)[0].toLowerCase() as GoalAction, objective: '' };
    return { action: 'start' as const, objective: value.replace(/^--\s+/, '') };
}
export async function readAgentGoal(companyId: string, agentId: string, viewerId?: string) {
    const [agent] = await db.select({ provider: agents.provider }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId), isNull(agents.deletedAt))).limit(1);
    if (!agent) throw new Error('Agent not found');
    const [message] = await db.select().from(threadMessages).where(and(eq(threadMessages.companyId, companyId), eq(threadMessages.targetAgentId, agentId), sql`${threadMessages.deliveryState} != 'cancelled'`, sql`${threadMessages.metadataJson} ? 'runtimeGoalRequest'`)).orderBy(desc(threadMessages.createdAt), desc(threadMessages.id)).limit(1);
    const metadata = message?.metadataJson as Record<string, unknown> | undefined;
    let goal = metadata?.runtimeGoalState ?? null;
    const ownerId = (goal as {ownerId?: string} | null)?.ownerId ?? message?.senderId;
    if (viewerId && ownerId && ownerId !== viewerId && !(await isCompanyOwnerOrAdmin(companyId, viewerId)) && goal) {
        const state = goal as {status:string;turnsUsed?:number;maxTurns?:number};
        goal = {status:state.status,turnsUsed:state.turnsUsed,maxTurns:state.maxTurns,message:'Managed in another private conversation.'};
    }
    return { supported: agent.provider === 'hermes', pending: message?.deliveryState === 'queued', goal };
}
export async function requestAgentGoal(companyId: string, userId: string, agentId: string, input: { action: GoalAction; objective?: string; maxTurns?: number }) {
    if (!input || typeof input !== 'object' || !['start','pause','resume','clear'].includes(input.action)) throw new Error('Invalid objective action');
    if (input.action === 'start' && (typeof input.objective !== 'string' || !input.objective.trim() || input.objective.length > 4000)) throw new Error('Objective must contain 1–4,000 characters');
    const maxTurns = input.maxTurns ?? 20;
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 20) throw new Error('Choose 1–20 turns');
    const current = await readAgentGoal(companyId, agentId);
    if (!current.supported) throw new Error('This runtime does not support persistent objectives');
    const thread = await ensureDirectThread(companyId, agentId, userId);
    const message = await db.transaction(async tx => {
        await tx.execute(sql`SELECT id FROM agents WHERE id = ${agentId}::uuid AND company_id = ${companyId}::uuid FOR NO KEY UPDATE`);
        if (input.action === 'start') {
            const [busy] = await tx.select({id:threadMessages.id}).from(threadMessages).where(and(eq(threadMessages.companyId,companyId),eq(threadMessages.targetAgentId,agentId),eq(threadMessages.senderType,'human'),sql`${threadMessages.deliveryState} IN ('queued','seen','acting')`)).limit(1);
            if (busy) throw new Error('Wait for current work to finish or stop it before starting an objective');
        }
        const [result] = await tx.insert(threadMessages).values({companyId,threadId:thread.id,targetAgentId:agentId,senderType:'system',senderId:userId,text:`Objective ${input.action} requested.`,deliveryState:'queued',metadataJson:{runtimeControl:{action:"goal"},runtimeGoalRequest:{action:input.action,objective:input.objective?.trim(),maxTurns}}}).returning();
        return result;
    });
    broadcastMcpEvent(companyId,{type:'thread_message',threadId:thread.id,message});
    return {thread,message,pending:true};
}

export async function replyAgentGoalStatus(companyId:string,userId:string,agentId:string){
    const result=await readAgentGoal(companyId,agentId,userId);
    const thread=await ensureDirectThread(companyId,agentId,userId);
    const goal=result.goal as {message?:string;contract?:string;status?:string}|null;
    const text=!result.supported?'This runtime does not support persistent objectives.':result.pending?'Objective request is awaiting runtime confirmation.':goal?[goal.message||`Objective: ${goal.status}`,goal.contract].filter(Boolean).join('\n\n'):'No objective has been reported. Start one with /goal <objective>.';
    const message=await appendThreadMessage({companyId,threadId:thread.id,targetAgentId:agentId,senderId:userId,senderType:'system',deliveryState:'resolved',text,metadataJson:{runtimeControl:{action:'goal_status'}}});
    broadcastMcpEvent(companyId,{type:'thread_message',threadId:thread.id,message});
    return {thread,message};
}
