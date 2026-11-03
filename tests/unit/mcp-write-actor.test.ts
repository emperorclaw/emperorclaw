import { test } from "node:test";
import assert from "node:assert/strict";
import {
    AGENT_ID_REQUIRED_BODY_ERROR, AGENT_ID_REQUIRED_ERROR, NO_PERSON_ON_TOKEN_ERROR, decideMcpWriter, mcpServerOperatorUserId,
} from "../../src/lib/mcp-write-actor";
import { restActionForRequest } from "../../src/lib/action-policy";

test("an agent-bound token always writes as its agent, on either channel", () => {
    for (const channel of ["rest", "mcp_server"] as const) {
        assert.deepEqual(decideMcpWriter({ channel, boundAgentId: "a1" }), { kind: "agent", agentId: "a1" });
        assert.deepEqual(decideMcpWriter({ channel, boundAgentId: "a1", tokenCreatorUserId: "u1" }), { kind: "agent", agentId: "a1" }, "the agent, never the person who minted it");
    }
});

test("REST: a company-wide token must name its agent; naming none is a 400, never 'system'", () => {
    assert.deepEqual(decideMcpWriter({ channel: "rest", actingAgentId: "a2" }), { kind: "agent", agentId: "a2" });
    assert.deepEqual(decideMcpWriter({ channel: "rest", namedAgent: true }), { kind: "named_agent" }, "an unresolved name is the route's 404 to give");
    assert.deepEqual(decideMcpWriter({ channel: "rest" }), { kind: "refused", status: 400, error: AGENT_ID_REQUIRED_ERROR });
    assert.deepEqual(decideMcpWriter({ channel: "rest", agentIn: "body" }), { kind: "refused", status: 400, error: AGENT_ID_REQUIRED_BODY_ERROR });
    // A person's token on the REST API is still refused: the row cannot tell a person from a fleet.
    assert.equal(decideMcpWriter({ channel: "rest", tokenCreatorUserId: "u1" }).kind, "refused");
    assert.equal(AGENT_ID_REQUIRED_ERROR, "agentId required: a company-wide token must say which agent is acting (?agentId=<id>)");
});

test("MCP server: a company-wide token naming no agent writes as the person who minted it, or is refused", () => {
    assert.deepEqual(decideMcpWriter({ channel: "mcp_server", tokenCreatorUserId: "u1" }), { kind: "person", userId: "u1" });
    assert.deepEqual(decideMcpWriter({ channel: "mcp_server" }), { kind: "refused", status: 400, error: NO_PERSON_ON_TOKEN_ERROR });
    assert.deepEqual(decideMcpWriter({ channel: "mcp_server", actingAgentId: "a3", tokenCreatorUserId: "u1" }), { kind: "agent", agentId: "a3" });
});

test("mcpServerOperatorUserId: only a company-wide token has an operator person", () => {
    assert.equal(mcpServerOperatorUserId({ agentId: null, createdByUserId: "u1" }), "u1");
    assert.equal(mcpServerOperatorUserId({ agentId: "a1", createdByUserId: "u1" }), null);
    assert.equal(mcpServerOperatorUserId({ agentId: null, createdByUserId: null }), null);
});

test("authored REST writes: views and messages/send, not reads or operator actions", () => {
    for (const [method, path] of [
        ["POST", "/api/mcp/views"], ["PATCH", "/api/mcp/views/v1"], ["PUT", "/api/mcp/views/v1/panels/p1"], ["POST", "/api/mcp/views/v1/archive"],
        ["POST", "/api/mcp/messages/send"],
    ] as const) {
        assert.equal(restActionForRequest(method, path)?.authored, true, `${method} ${path}`);
    }
    for (const [method, path] of [
        ["GET", "/api/mcp/views"], ["POST", "/api/mcp/agents"], ["POST", "/api/mcp/requests"], ["POST", "/api/mcp/tasks"], ["POST", "/api/mcp/groups"],
    ] as const) {
        assert.equal(restActionForRequest(method, path)?.authored ?? false, false, `${method} ${path}`);
    }
});
