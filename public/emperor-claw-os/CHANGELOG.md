# Changelog

All notable changes to the Emperor Claw OS skill will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.10.0] - 2026-03-10

### Added
- **Asset Bundle Package:** Introduced a formal `assets/` directory with a dedicated Emperor Claw branding logo.
- **API Example Suite:** Added `examples/` directory with high-fidelity JSON payloads for all core MCP endpoints (Claim, Note, Complete, Registration).
- **CLI Tooling:** Added `scripts/ec-cli.sh`, a bash helper for interacting with the Emperor Claw API from the terminal.
- **Enhanced Documentation:** Updated README and SKILL.md to reference the new asset-driven structure.

## [1.9.0] - 2026-03-10

### Added
- **Operational Playbook Enhancements:** Integrated best-in-class operational practices for Agent Experience (AX).
- **🚀 Quick Start (Agent Activation):** Added explicit verbal triggers so humans know exactly how to activate the agent.
- **Visual Operational Flow:** Added an ASCII flow diagram showing the entire Control Plane architecture inside the `SKILL.md`.
- **Explicit Agent Task Workflow:** Replaced implicit API knowledge with a formal 8-step checklist for worker agents executing tasks.
- **Support for EPICs & Rework:** Formalized instructions for handling complex task sequences (`blockedByTaskIds`) and rework loops.
- **Added Full Documentation Suite:** Introduced `README.md`, `HOW-IT-WORKS.md`, `PREREQUISITES.md`, and `TROUBLESHOOTING.md` alongside the skill.

## [1.8.0] - 2026-03-10

### Added
- **Mandatory Long-Logging (Transparency):** Enforced a "Log-as-you-go" doctrine. Every agent thought, milestone, decision, and blocker must be logged to the `chat_messages` table.
- **Sub-Agent Clarification:** Formally stated that sub-agents are first-class agents with autonomous memory and records in the system.

## [1.7.0] - 2026-03-05

### Added
- **Agent Memory API Integration:** Instructions for treating the Emperor Claw `memory` field as a persistent cross-session scratchpad.
