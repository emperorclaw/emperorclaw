import test from 'node:test';
import assert from 'node:assert/strict';
import {dbAvailable,resetDb,seedCompanyWithToken,seedAgent,getDb,getSchema,makeRequest} from './_helper';
const maybe=dbAvailable?test:test.skip;
maybe('objective commands are durable, bound to their runtime, and isolated from ordinary prompts',async()=>{
 await resetDb();const {companyId,userId,rawToken}=await seedCompanyWithToken();const agent=await seedAgent(companyId,{provider:'hermes'});const sibling=await seedAgent(companyId,{provider:'hermes',name:'Sibling'});
 const {requestAgentGoal,readAgentGoal,replyAgentGoalStatus}=await import('@/lib/agent-goal');const {eq}=await import('drizzle-orm');const db=await getDb();const {companyTokens}=await getSchema();await db.update(companyTokens).set({agentId:agent.id}).where(eq(companyTokens.companyId,companyId));
 await assert.rejects(()=>requestAgentGoal(companyId,userId,agent.id,{action:'start',objective:'',maxTurns:20}),/Objective/);
 await assert.rejects(()=>requestAgentGoal(companyId,userId,agent.id,{action:'start',objective:'Fix tests',maxTurns:100}),/1–20/);
 const started=await requestAgentGoal(companyId,userId,agent.id,{action:'start',objective:'Fix tests',maxTurns:5});
 assert.equal((await readAgentGoal(companyId,agent.id)).pending,true);
 assert.deepEqual((started.message.metadataJson as {runtimeControl:unknown}).runtimeControl,{action:'goal'});
 const route=await import('@/app/api/mcp/agents/goals/route');const headers={authorization:`Bearer ${rawToken}`};
 const get=await route.GET(makeRequest(`http://localhost/api/mcp/agents/goals?agentId=${agent.id}`,{headers}));assert.equal((await get.json()).commands[0].id,started.message.id);
 assert.equal((await route.GET(makeRequest(`http://localhost/api/mcp/agents/goals?agentId=${sibling.id}`,{headers}))).status,403);
 const {appendThreadMessage}=await import('@/lib/control-plane');const ordinary=await appendThreadMessage({companyId,threadId:started.thread.id,targetAgentId:agent.id,senderType:'human',senderId:userId,text:'Ordinary prompt',deliveryState:'queued'});
 const sync=await import('@/app/api/mcp/messages/sync/route');const delivered=await sync.GET(makeRequest(`http://localhost/api/mcp/messages/sync?agentId=${agent.id}&mode=all`,{headers}));
 const delivery=await delivered.json();assert.ok(delivery.messages.some((m:{id:string})=>m.id===ordinary.id));assert.ok(!delivery.messages.some((m:{id:string})=>m.id===started.message.id));

 const ack=await route.POST(makeRequest(`http://localhost/api/mcp/agents/goals?agentId=${agent.id}`,{method:'POST',headers,body:{commandId:started.message.id,goal:{status:'active',objective:'Fix tests',turnsUsed:1,maxTurns:5}}}));assert.equal(ack.status,200);
 const statusReply=await replyAgentGoalStatus(companyId,userId,agent.id);assert.equal(statusReply.message.senderType,'system');assert.ok(statusReply.message.text.includes('active'));
 assert.equal((await readAgentGoal(companyId,agent.id)).pending,false);assert.equal(((await readAgentGoal(companyId,agent.id)).goal as {status:string}).status,'active');
 assert.deepEqual((await (await route.GET(makeRequest(`http://localhost/api/mcp/agents/goals?agentId=${agent.id}`,{headers}))).json()).commands,[]);
 const {users}=await getSchema();const [another]=await db.insert(users).values({email:'another-goal-test@example.test',passwordHash:'test',displayName:'Another'}).returning();
 const privateView=await readAgentGoal(companyId,agent.id,another.id);assert.equal((privateView.goal as {objective?:string}).objective,undefined);
 const siblingGoal=await requestAgentGoal(companyId,userId,sibling.id,{action:'start',objective:'Sibling objective'});
 const deniedUpdate=await route.POST(makeRequest(`http://localhost/api/mcp/agents/goals?agentId=${agent.id}`,{method:'POST',headers,body:{commandId:siblingGoal.message.id,goal:{status:'done'}}}));assert.equal((await deniedUpdate.json()).ok,false);
 const {requestAgentControl}=await import('@/lib/agent-control');const pendingGoal=await requestAgentGoal(companyId,userId,agent.id,{action:'resume'});await requestAgentControl(companyId,userId,agent.id,'kill','');
 const lateGoalAck=await route.POST(makeRequest(`http://localhost/api/mcp/agents/goals?agentId=${agent.id}`,{method:'POST',headers,body:{commandId:pendingGoal.message.id,goal:{status:'active'}}}));assert.equal((await lateGoalAck.json()).ok,false);
 const forged=await route.POST(makeRequest(`http://localhost/api/mcp/agents/goals?agentId=${agent.id}`,{method:'POST',headers,body:{commandId:started.message.id,goal:{status:'done',message:'x'.repeat(17000)}}}));assert.equal(forged.status,400);
});
maybe('objectives reject busy and unsupported agents',async()=>{
 await resetDb();const {companyId,userId}=await seedCompanyWithToken();const agent=await seedAgent(companyId,{provider:'hermes'});const other=await seedAgent(companyId,{provider:'openclaw',name:'Other'});
 const {requestAgentGoal}=await import('@/lib/agent-goal');const {requestAgentControl}=await import('@/lib/agent-control');await requestAgentControl(companyId,userId,agent.id,'queue','Current work');
 await assert.rejects(()=>requestAgentGoal(companyId,userId,agent.id,{action:'start',objective:'New work'}),/current work/);
 await assert.rejects(()=>requestAgentGoal(companyId,userId,other.id,{action:'start',objective:'New work'}),/does not support/);
});
