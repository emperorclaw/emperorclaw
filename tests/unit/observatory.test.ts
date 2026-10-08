import assert from "node:assert/strict";
import { test } from "node:test";
import { observatoryBays, visibleCommunications, sceneMessagePreview } from "../../src/lib/observatory";
import { deriveSceneAgents, type SceneCommunication } from "../../src/lib/team-scene";
import { dashboardFixture } from "../fixtures/dashboard";

test("thirty agents stay reachable, each once, across bays capped at six", () => {
    const agents = deriveSceneAgents(dashboardFixture(30));
    const teams = [{id:"a",name:"Studio",memberKeys:agents.slice(0,20).map(a=>a.member.key)},{id:"b",name:"Ops",memberKeys:agents.slice(10,25).map(a=>a.member.key)}];
    const bays = observatoryBays(agents, teams, null);
    const keys = bays.flatMap(b=>b.agents.map(a=>a.member.key));
    assert.equal(keys.length,30); assert.equal(new Set(keys).size,30);
    assert.ok(bays.every(b=>b.agents.length<=6));
    assert.equal(observatoryBays(agents,teams,"b").flatMap(b=>b.agents).length,15);
    assert.equal(bays.at(-1)?.name,"Sector 05");
    assert.ok(bays.every(b=>b.teamId===null));
    assert.deepEqual(observatoryBays(agents,teams,null).flatMap(b=>b.agents.map(a=>a.member.key)),observatoryBays(agents,[...teams].reverse(),null).flatMap(b=>b.agents.map(a=>a.member.key)));
});
test("placement does not change when work status or input order changes", () => {
    const agents = deriveSceneAgents(dashboardFixture(12));
    assert.deepEqual(observatoryBays(agents,[],null).map(b=>b.agents.map(a=>a.member.key)),observatoryBays([...agents].reverse(),[],null).map(b=>b.agents.map(a=>a.member.key)));
    assert.deepEqual(observatoryBays([],[],null),[]);
});
test("speaking cues expire, obey room scope, and disappear on stale snapshots", () => {
    const now=new Date("2026-10-08T20:00:00Z");
    const message:SceneCommunication={id:"m",actorKey:"a",targetKey:"b",teamId:null,text:"Ready",href:"/messages",at:now.toISOString()};
    const keys=new Set(["a","b"]);
    const messages=[message,{...message,id:"old",at:"2026-10-08T19:59:30Z"},{...message,id:"other-room",teamId:"other"},{...message,id:"unknown",actorKey:"c"},{...message,id:"future",at:"2026-10-08T20:00:01Z"}];
    assert.deepEqual(visibleCommunications(messages,keys,now,true,"studio").map(m=>m.id),["m"]);
    assert.deepEqual(visibleCommunications(messages,keys,now,false,null),[]);
});

test("large Markdown responses stay bounded and keep the scene free of document scaffolding", () => {
    const preview=sceneMessagePreview("# Launch plan\n\n**Research** and [sources](https://example.com)\n"+"Detailed findings. ".repeat(50000));
    assert.ok(Array.from(preview).length<=112);
    assert.ok(preview.startsWith("Shared a detailed response:"));
    assert.ok(!preview.includes("**") && !preview.includes("https://"));
    assert.equal(sceneMessagePreview("```python\nprint('hello')\n```"),"Shared code · open conversation");
    assert.equal(sceneMessagePreview("Ready for review."),"Ready for review.");
    assert.ok(!sceneMessagePreview("😀".repeat(100)).includes("\uFFFD"));
});
