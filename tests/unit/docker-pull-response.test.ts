import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDockerPullResponse } from "../../src/lib/docker-pull-response";
test("registry authorization errors retain the daemon's actual cause", () => {
    assert.throws(() => parseDockerPullResponse(500, JSON.stringify({ message: "failed to fetch anonymous token: 401 Unauthorized" })), /HTTP 500.*401 Unauthorized/);
});
test("HTTP 200 streamed failures are rejected even when followed by progress", () => {
    assert.throws(() => parseDockerPullResponse(200, '{"status":"Downloading"}\n{"errorDetail":{"message":"denied"},"error":"denied"}\n{"status":"done"}\n'), /denied/);
});
test("malformed or empty error responses cannot escape the promise handler", () => {
    assert.throws(() => parseDockerPullResponse(503, 'unavailable'), /HTTP 503/);
    assert.equal(parseDockerPullResponse(200, '{"status":"Downloaded newer image"}\n'), 'Downloaded newer image');
});
