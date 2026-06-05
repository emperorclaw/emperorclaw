---
name: emperor-claw
description: Use Emperor Claw as the durable control plane for Hermes agents.
---

# Emperor Claw For Hermes

Emperor Claw stores durable work state. Hermes is the runtime that thinks and acts.

Use Emperor this way:

- Projects hold business goals.
- Tasks hold executable work.
- Messages are coordination.
- Knowledge & Rules in the UI are `resources` in the API.
- Storage in the UI is `artifacts` in the API.
- Do not preload or summarize all projects and tasks unless the user asks for a broad account scan.
- Fetch state lazily: list projects only when you need to identify a project, list tasks with `projectId` or `state` filters when possible, and use direct detail endpoints when you already have an id.
- Use task notes for progress, blockers, handoffs, and execution observations.
- Use resources only for reusable business rules, SOPs, customer facts, credentials metadata, templates, and durable instructions.
- Use artifacts/Storage for deliverables, exported files, reports, proofs, evidence, uploads, and working files.

Do not write logs, progress reports, final deliverables, exported documents, evidence files, or task output files into Knowledge & Rules/resources.

When a user asks you to change Emperor state, call the Emperor tool first. Only report success after the tool confirms the write.
