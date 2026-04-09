# Activation Protocol

This is the practical activation path for a plugin-based Emperor agent.

## 1. Install The Plugin

```bash
openclaw plugins install clawhub:@malecu/emperor-claw-os-plugin
```

## 2. Set The Company Token

```bash
export EMPEROR_CLAW_API_TOKEN="<company-token>"
```

## 3. Add The Agent

```bash
openclaw emperor add-agent --name "<Agent Name>"
```

## 4. Validate Local Health

```bash
openclaw emperor doctor
openclaw emperor status
```

## 5. Confirm Runtime Registration

The plugin bootstrap should register the runtime and agent with Emperor automatically.

## 6. Confirm Messaging

Open Emperor and send the new agent a direct message.

You should see:

- direct-thread provisioning or reuse
- typing status during work
- one final durable reply

## 7. Confirm Team Coordination

Mention the agent in the team thread with `@Agent Name`.

That validates team-thread routing and visible coordination.

## 8. Confirm Doctrine And Resources

The plugin should seed:

- local workspace doctrine/manuals
- shared company doctrine resources in Emperor

## 9. Confirm Repair Path

If the bridge or workspace bootstrap changes later, use:

```bash
openclaw emperor repair
```

This re-applies the bridge/runtime assets and doctrine to installed agents.

## 10. Operating Expectation

After activation, the agent should:

- reply in direct threads
- respond in team chat when explicitly `@mentioned`
- use Emperor as the durable system of record
- treat the plugin bridge as transport/context glue, not as a substitute for reasoning
