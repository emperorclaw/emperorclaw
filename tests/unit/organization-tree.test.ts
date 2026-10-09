import test from 'node:test';
import assert from 'node:assert/strict';
import {validateOrganizationTree,removeOrganizationBranch,type OrganizationNode} from '../../src/lib/organization-tree';
const root:OrganizationNode={id:'ceo',parentId:null,kind:'person',person:{kind:'human',id:'human'}};
const ai:OrganizationNode={id:'ai',parentId:'ceo',kind:'person',person:{kind:'agent',id:'boss'}};
const team:OrganizationNode={id:'team',parentId:'ai',kind:'team',teamId:'design',leaderAgentId:'lead'};
test('human executive needs an AI leader below and teams need an AI leader',()=>{
 assert.throws(()=>validateOrganizationTree([root]),/AI leader beneath/);
 assert.deepEqual(validateOrganizationTree([root,ai,team]),[root,ai,team]);
 assert.throws(()=>validateOrganizationTree([root,ai,{...team,leaderAgentId:''}]),/AI leader/);
});
test('shared agents can belong to sibling teams but never report to themselves',()=>{
 const team2={...team,id:'team2',teamId:'research',leaderAgentId:'research-lead'};
 const a:OrganizationNode={id:'a1',parentId:'team',kind:'person',person:{kind:'agent',id:'shared'}};
 const b={...a,id:'a2',parentId:'team2'};
 assert.equal(validateOrganizationTree([root,ai,team,team2,a,b]).length,6);
 assert.throws(()=>validateOrganizationTree([root,ai,{id:'bad',parentId:'ai',kind:'person',person:ai.person}]),/itself/);
});
test('graph rejects cycles, missing parents, duplicate teams, and human reports below agents',()=>{
 assert.throws(()=>validateOrganizationTree([root,{...ai,parentId:'missing'}]),/Parent/);
 assert.throws(()=>validateOrganizationTree([root,{...ai,parentId:'team'},team]),/loop/);
 assert.throws(()=>validateOrganizationTree([root,ai,team,{...team,id:'duplicate'}]),/already/);
 assert.throws(()=>validateOrganizationTree([root,ai,{...root,id:'cto',parentId:'ai'}]),/above AI/);
 assert.throws(()=>validateOrganizationTree([root,ai,team,{id:'recursive-boss',parentId:'team',kind:'person',person:ai.person}]),/descendants|Team members/);
});
test('removing a branch preserves sibling memberships for a shared agent',()=>{
 const team2={...team,id:'team2',teamId:'research',leaderAgentId:'research-lead'};
 assert.deepEqual(removeOrganizationBranch([root,ai,team,team2],team.id),[root,ai,team2]);
});

test('teams are terminal work units: no nested team or branches through a teammate',()=>{
 const member:OrganizationNode={id:'member',parentId:team.id,kind:'person',person:{kind:'agent',id:'worker'}};
 const nested={...team,id:'nested',teamId:'nested-group',leaderAgentId:'nested-lead',parentId:team.id};
 assert.throws(()=>validateOrganizationTree([root,ai,team,nested]),/Teams cannot contain/);
 assert.throws(()=>validateOrganizationTree([root,ai,team,member,{...nested,parentId:member.id}]),/Team members cannot/);
 assert.throws(()=>validateOrganizationTree([root,ai,team,member,{...member,id:'report',parentId:member.id,person:{kind:'agent',id:'other'}}]),/Team members cannot/);
 assert.equal(validateOrganizationTree([root,ai,team,member,{...nested,parentId:ai.id}]).length,5);
});


test('company and team leaders stay exclusive while ordinary specialists can be shared', () => {
 const boss:OrganizationNode={id:'boss',parentId:null,kind:'person',person:{kind:'agent',id:'ceo'}};
 const a:OrganizationNode={id:'a',parentId:'boss',kind:'team',teamId:'a',leaderAgentId:'lead-a'};
 const b:OrganizationNode={id:'b',parentId:'boss',kind:'team',teamId:'b',leaderAgentId:'lead-b'};
 const worker:OrganizationNode={id:'worker-a',parentId:'a',kind:'person',person:{kind:'agent',id:'worker'}};
 assert.equal(validateOrganizationTree([boss,a,b,worker,{...worker,id:'worker-b',parentId:'b'}]).length,5);
 assert.throws(()=>validateOrganizationTree([boss,a,{...b,leaderAgentId:'lead-a'}]),/one team/);
 assert.throws(()=>validateOrganizationTree([boss,{...a,leaderAgentId:'ceo'}]),/company AI leader/);
 assert.throws(()=>validateOrganizationTree([boss,a,b,{...worker,person:{kind:'agent',id:'lead-b'}}]),/cannot be shared/);
});
