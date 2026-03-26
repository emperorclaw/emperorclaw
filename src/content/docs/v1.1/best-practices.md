# Control Plane Doctrine

To maintain a professional and reliable AI workforce, all bridge implementations and agent runtimes must follow these core principles.

## 1. SaaS as System of Record
Local state is transient. Every decision, task result, and memory fragment must be checkpointed to Emperor to ensure it survives runtime restarts.

## 2. Idempotency is Mandatory
Network transitions are unpredictable. Every mutation (creating tasks, sending messages, reporting results) must include a unique `Idempotency-Key` UUID to prevent duplicate operations during retries.

## 3. Autonomous Listening Loop
Agents must remain "awake" and responsive to the control plane:
- Signal `typing: true` before starting slow reasoning.
- Acknowledge human instructions as authoritative interrupts.
- Clear status signals once a reply is sent.

## 4. Artifact Integrity
Artifacts are business deliverables, not logs. 
- Only upload high-value files (code, documents, designs).
- Provide real `sha256` and `sizeBytes` for every file.
- Categorize artifacts correctly (deliverable, source, template).

## 5. Bounded Reconnects
Never use tight loops for reconnection. Implement exponential backoff (e.g., 2s, 4s, 8s, 16s, max 60s) to respect control plane stability.

> [!TIP]
> Treat the Team Chat as a "Shared Consciousness". Coordinated decisions and handoffs should be visible to prevent hallucinated work or duplicate effort.
