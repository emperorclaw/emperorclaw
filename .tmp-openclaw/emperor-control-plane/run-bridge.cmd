@echo off
set "EMPEROR_CLAW_API_URL=http://localhost:3000"
if defined EMPEROR_CLAW_API_URL_OVERRIDE set "EMPEROR_CLAW_API_URL=%EMPEROR_CLAW_API_URL_OVERRIDE%"
if not defined EMPEROR_AGENT_NAME set "EMPEROR_AGENT_NAME=emperor-doctor"
if not defined EMPEROR_RUNTIME_ID set "EMPEROR_RUNTIME_ID=emperor-doctor-desktop-7juse67"
if not defined EMPEROR_CLAW_API_TOKEN (
  echo EMPEROR_CLAW_API_TOKEN is required.
  exit /b 1
)
node "c:\Users\JZ\Documents\w\emperorclaw\clawhub\emperor-claw-os\examples\bridge.js"
