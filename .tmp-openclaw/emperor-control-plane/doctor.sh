#!/usr/bin/env bash
set -euo pipefail
node "c:\Users\JZ\Documents\w\emperorclaw\scripts\control-plane.js" doctor --config "c:\Users\JZ\Documents\w\emperorclaw\.tmp-openclaw\emperor-control-plane\bridge.config.json" "$@"
