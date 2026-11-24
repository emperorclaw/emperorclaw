# Optional Apple push relay

Dependency-free Node 22+ APNs provider for independently hosted EmperorClaw servers. Apps work without it. Run behind a trusted HTTPS reverse proxy; the process binds to loopback port 8087 by default.

## Configuration

Set these environment variables on the relay host:

- `APNS_KEY_PATH`: path to the Apple APNs authentication `.p8` private key, readable only by the service account.
- `APNS_TEAM_ID`, `APNS_KEY_ID`: Apple team and authentication-key IDs.
- `APNS_TOPIC`: iPhone bundle ID, `com.emperorclaw.ios`. Watch topic appends `.watchkitapp`.
- `PUSH_INSTALLATIONS_JSON`: JSON object mapping each server's discovery `installationId` to its own random shared secret of at least 32 characters. Never reuse one secret across installations.
- `PUSH_STATE_FILE`: persistent path for confirmed device bindings (default `./data/devices.json`). Protect and back up this directory. Pending challenges/deduplication are memory-only.
- `PORT`: optional loopback listening port.

On each user VPS, set `MOBILE_PUSH_RELAY_URL` to the relay's HTTPS origin and `MOBILE_PUSH_RELAY_KEY` to that installation's secret. The normal EmperorClaw encryption master key must be configured for encrypted APNs token storage. Restart the server after changing configuration. Debug builds use APNs sandbox; release builds use production.

Run `node server.mjs`; test with `node --test server.test.mjs` from this directory. Supervise with your normal service manager. Configure TLS, request limits, monitoring and protected secrets at the reverse proxy. Do not expose the loopback service directly or log request bodies/device tokens.

## Enrollment and delivery

Requests carry an HMAC signature and timestamp with a five-minute window. Enrollment sends a random challenge through APNs; only the device that receives that challenge can confirm its binding to the installation, environment and device kind. The HTTP enrollment response never reveals the challenge. In-app enablement requires notification permission and confirmation of that delivered message.

The VPS checks current membership/visibility before forwarding an event. APNs messages carry generic attention text and resource IDs, without chat content. Opening a notification selects its saved installation and reloads the resource through authenticated server permissions. The relay stores hashes of confirmed token bindings, not raw device tokens. Delivery deduplicates event IDs for 24 hours while the process runs; process restart clears this cache. Ambiguous APNs sends are not automatically retried. APNs errors do not fail the underlying business operation.

This service has automated protocol tests, but has not been deployed or validated against real APNs credentials. Operational ownership, credential rotation, retention and device testing are release responsibilities. Re-enable notifications after APNs token changes or loss of persisted relay state.
