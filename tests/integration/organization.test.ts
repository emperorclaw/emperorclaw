import test from 'node:test';
import assert from 'node:assert/strict';
import {dbAvailable,resetDb,seedCompanyWithToken,seedAgent,getDb,getSchema,makeRequest} from './_helper';
const maybe=dbAvailable?test:test.skip;
maybe('organization reuses chats, rejects foreign leaders, and exposes only own team reporting',async()=>{
 await resetDb();const {companyId,userId,rawToken}=await seedCompanyWithToken();const me=await seedAgent(companyId);const lead=await seedAgent(companyId,{name:'Boss'});const other=await seedAgent(companyId,{name:'Other'});
 const {createGroup}=await import('@/lib/groups');const own=await createGroup(companyId,{type:'human',id:userId},{title:'Design',agentIds:[me.id,lead.id],coordinator:{kind:'agent',id:lead.id}});const hidden=await createGroup(companyId,{type:'human',id:userId},{title:'Other team',agentIds:[other.id]});
 const {loadOrganization,saveOrganization,parseOrganization}=await import('@/lib/organization');assert.equal((await loadOrganization(companyId)).configured,false);
 assert.throws(()=>parseOrganization({leader:[me.id,lead.id],teamIds:[]}),/leader/);
 await assert.rejects(()=>saveOrganization(companyId,{leader:{kind:'agent',id:'foreign-id'},teamIds:[]}),/belong/);
 await assert.rejects(()=>saveOrganization(companyId,{leader:null,teamIds:['foreign-group']}),/active/);
 await saveOrganization(companyId,{leader:{kind:'agent',id:lead.id},teamIds:[own.id,hidden.id,own.id]});await assert.rejects(()=>saveOrganization(companyId,{leader:null,teamIds:[]},true),/already configured/);const org=await loadOrganization(companyId);assert.equal(org.config.teamIds.length,2);assert.equal(org.leader?.id,lead.id);assert.equal(org.teams[0].id,own.id);
 const db=await getDb();const {companyTokens}=await getSchema();const {eq}=await import('drizzle-orm');await db.update(companyTokens).set({agentId:me.id}).where(eq(companyTokens.companyId,companyId));
 const route=await import('@/app/api/mcp/organization/route');const headers={authorization:`Bearer ${rawToken}`};const response=await route.GET(makeRequest(`http://localhost/api/mcp/organization?agentId=${me.id}`,{headers}));assert.equal(response.status,200);const brief=await response.json();assert.equal(brief.leader.name,'Boss');assert.equal(brief.teams.length,1);assert.equal(brief.teams[0].id,own.id);assert.equal(brief.teams[0].coordinator.id,lead.id);
 assert.equal((await route.GET(makeRequest(`http://localhost/api/mcp/organization?agentId=${other.id}`,{headers}))).status,403);
 await saveOrganization(companyId,{leader:null,teamIds:[]});assert.equal((await loadOrganization(companyId)).groups.length,2,'Removing branches must not delete chats');
});
maybe('reporting tree supports human executives, mandatory AI team leaders and shared agents',async()=>{
 await resetDb();const {companyId,userId,rawToken}=await seedCompanyWithToken();const boss=await seedAgent(companyId,{name:'Director'});const lead=await seedAgent(companyId,{name:'Design lead'});const other=await seedAgent(companyId,{name:'Research lead'});const member=await seedAgent(companyId,{name:'Shared'});
 const db=await getDb();const {companyMembers,companyTokens}=await getSchema();await db.insert(companyMembers).values({companyId,userId,role:'owner'});
 const {createGroup}=await import('@/lib/groups');const design=await createGroup(companyId,{type:'human',id:userId},{title:'Design',agentIds:[lead.id,member.id]});const research=await createGroup(companyId,{type:'human',id:userId},{title:'Research',agentIds:[other.id,member.id]});
 const {saveOrganization}=await import('@/lib/organization');const nodes=[{id:'ceo',parentId:null,kind:'person',person:{kind:'human',id:userId}},{id:'boss',parentId:'ceo',kind:'person',person:{kind:'agent',id:boss.id}},{id:'design',parentId:'boss',kind:'team',teamId:design.id,leaderAgentId:lead.id},{id:'research',parentId:'boss',kind:'team',teamId:research.id,leaderAgentId:other.id},{id:'shared-design',parentId:'design',kind:'person',person:{kind:'agent',id:member.id}},{id:'shared-research',parentId:'research',kind:'person',person:{kind:'agent',id:member.id}}];
 await saveOrganization(companyId,{leader:{kind:'human',id:userId},teamIds:[design.id,research.id],nodes:nodes.filter(n=>n.id!=='shared-research')});
 await assert.rejects(()=>saveOrganization(companyId,{leader:null,teamIds:[],nodes:[nodes[0]]}),/AI leader beneath/);
 await assert.rejects(()=>saveOrganization(companyId,{leader:{kind:'human',id:userId},teamIds:[design.id,research.id],nodes:nodes.map(n=>n.id==='design'?{...n,leaderAgentId:boss.id}:n)}),/who is a member/);
 const {eq}=await import('drizzle-orm');await db.update(companyTokens).set({agentId:member.id}).where(eq(companyTokens.companyId,companyId));const route=await import('@/app/api/mcp/organization/route');const response=await route.GET(makeRequest(`http://localhost/api/mcp/organization?agentId=${member.id}`,{headers:{authorization:`Bearer ${rawToken}`}}));const info=await response.json();assert.equal(info.reporting.length,2);assert.deepEqual(info.reporting.map((r:{reportsTo:{id:string}})=>r.reportsTo.id).sort(),[lead.id,other.id].sort());
});
