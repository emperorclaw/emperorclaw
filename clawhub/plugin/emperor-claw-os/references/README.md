# Emperor Claw OS Plugin (Scaffold)

This folder is the dedicated native OpenClaw plugin target for Emperor Claw OS.
It intentionally exists separately from `clawhub/emperor-claw-os` so plugin work
can proceed without destabilizing the existing skill package.

Current status:
- plugin manifest and package scaffolded
- basic commands added: install, doctor, add-agent, list-agents
- local manifest/state layout scaffolded
- service hook scaffolded

Next implementation loops should replace scaffold behavior with full Emperor API,
OpenClaw agent bootstrap, service supervision, repair, and routing management.
