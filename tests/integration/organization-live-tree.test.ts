import test from 'node:test';
import assert from 'node:assert/strict';
import {dbAvailable,resetDb,seedCompanyWithToken,seedAgent,getDb,getSchema,makeRequest} from './_helper';
const maybe=dbAvailable?test:test.skip;

/**
 * The reported symptom: GET /api/mcp/organization served a tree naming a leader
 * who no longer coordinates the room, members who had left it and an agent that
 * no longer existed ("An agent"), because the chart it printed is a snapshot
 * written by the chart editor and a room is edited somewhere else.
 */
maybe('the chart follows its rooms: a new coordinator, departed members and a deleted agent never reach a reader',async()=>{
 await resetDb();
 const {companyId,userId,rawToken}=await seedCompanyWithToken();
 const architect=await seedAgent(companyId,{name:'Hermes-Architect'});
 const builder=await seedAgent(companyId,{name:'Builder'});
 const courier=await seedAgent(companyId,{name:'Courier'});
 const viktor=await seedAgent(companyId,{name:'Viktor'});
 const leaver=await seedAgent(companyId,{name:'Leaver'});
 const db=await getDb();const {agents,companyMembers,companyTokens}=await getSchema();const {eq}=await import('drizzle-orm');
 await db.insert(companyMembers).values({companyId,userId,role:'owner'});
 const {createGroup,updateGroup,removeGroupMember}=await import('@/lib/groups');
 // The rooms as the chart was saved against: Builder coordinates Development and
 // sits in it; Viktor coordinates Operations.
 const dev=await createGroup(companyId,{type:'human',id:userId},{title:'Development team',agentIds:[architect.id,builder.id,courier.id,leaver.id,viktor.id],coordinator:{kind:'agent',id:builder.id}});
 const ops=await createGroup(companyId,{type:'human',id:userId},{title:'Operations — fleet, deploys y crons',agentIds:[builder.id,viktor.id],coordinator:{kind:'agent',id:viktor.id}});
 const {saveOrganization,loadOrganization}=await import('@/lib/organization');
 const nodes=[
  {id:'ceo',parentId:null,kind:'person',person:{kind:'human',id:userId}},
  {id:'architect',parentId:'ceo',kind:'person',person:{kind:'agent',id:architect.id}},
  {id:'dev',parentId:'architect',kind:'team',teamId:dev.id,leaderAgentId:builder.id},
  {id:'courier',parentId:'dev',kind:'person',person:{kind:'agent',id:courier.id}},
  {id:'leaver',parentId:'dev',kind:'person',person:{kind:'agent',id:leaver.id}},
  {id:'ops',parentId:'architect',kind:'team',teamId:ops.id,leaderAgentId:viktor.id},
 ];
 await saveOrganization(companyId,{leader:{kind:'human',id:userId},teamIds:[dev.id,ops.id],nodes});

 // Then the room itself is fixed where rooms are fixed (Messages → the room):
 // Architect coordinates, Builder and Courier leave, Leaver's agent is deleted.
 // Viktor was always in the room but never sat on the chart.
 await updateGroup(companyId,dev.id,{coordinator:{kind:'agent',id:architect.id}});
 await updateGroup(companyId,ops.id,{coordinator:{kind:'agent',id:builder.id}});
 await removeGroupMember(companyId,dev.id,{kind:'agent',id:builder.id});
 await removeGroupMember(companyId,dev.id,{kind:'agent',id:courier.id});
 await removeGroupMember(companyId,dev.id,{kind:'agent',id:leaver.id});
 await db.delete(agents).where(eq(agents.id,leaver.id));

 await db.update(companyTokens).set({agentId:architect.id}).where(eq(companyTokens.companyId,companyId));
 const route=await import('@/app/api/mcp/organization/route');
 const response=await route.GET(makeRequest(`http://localhost/api/mcp/organization?agentId=${architect.id}`,{headers:{authorization:`Bearer ${rawToken}`}}));
 assert.equal(response.status,200);
 const brief=await response.json();
 assert.equal(brief.configured,true);
 const tree=String(brief.tree);
 assert.match(tree,/Team Development team, led by Hermes-Architect/);
 const devLine=tree.split('\n').find(line=>line.includes('Team Development team'));
 assert.ok(devLine?.includes('led by Hermes-Architect'),`the team node names the room's coordinator:\n${tree}`);
 assert.ok(!devLine?.includes('Builder'),`a former coordinator must not lead the team node:\n${tree}`);
 assert.ok(!tree.includes('Courier'),`a member who left the room must not be on the chart:\n${tree}`);
 assert.ok(!tree.includes('An agent'),`a deleted agent must not be printed as an anonymous node:\n${tree}`);
 assert.ok(tree.includes('Viktor'),`a member of the room must appear under its team:\n${tree}`);
 assert.ok(!tree.includes('Leaver'),tree);

 assert.match(tree,/Team Operations — fleet, deploys y crons, led by Builder/,`the second room follows its own coordinator too:\n${tree}`);
 assert.ok(!tree.includes('led by Viktor'),`the coordinator Operations had when the chart was saved must not lead it:\n${tree}`);

 // The chart page reads the same reconciled structure, so the editor shows it.
 const org=await loadOrganization(companyId);
 assert.equal(org.leader?.id,userId);
 const teamNode=org.config.nodes?.find(node=>node.kind==='team'&&node.teamId===dev.id);
 assert.equal(teamNode?.kind==='team'?teamNode.leaderAgentId:null,architect.id,'The team node carries the room coordinator');
 const opsNode=org.config.nodes?.find(node=>node.kind==='team'&&node.teamId===ops.id);
 assert.equal(opsNode?.kind==='team'?opsNode.leaderAgentId:null,builder.id,'Each room follows its own coordinator');
 assert.deepEqual(org.config.teamIds,[dev.id,ops.id]);
});
