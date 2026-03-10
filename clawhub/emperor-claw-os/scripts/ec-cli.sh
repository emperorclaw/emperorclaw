#!/bin/bash

# Emperor Claw CLI Wrapper
# Usage: ./ec-cli.sh <command> <payload_json_path>

BASE_URL="https://emperorclaw.malecu.eu/api/mcp"

if [ -z "$EMPEROR_CLAW_API_TOKEN" ]; then
  echo "Error: EMPEROR_CLAW_API_TOKEN environment variable not set."
  exit 1
fi

COMMAND=$1
PAYLOAD_FILE=$2

case $COMMAND in
  claim)
    ENDPOINT="/tasks/$(cat $PAYLOAD_FILE | jq -r .taskId)/claim"
    ;;
  note)
    ENDPOINT="/tasks/$(cat $PAYLOAD_FILE | jq -r .taskId)/notes"
    ;;
  complete)
    ENDPOINT="/tasks/$(cat $PAYLOAD_FILE | jq -r .taskId)/complete"
    ;;
  *)
    echo "Unknown command: $COMMAND"
    echo "Usage: ./ec-cli.sh [claim|note|complete] <payload_json_path>"
    exit 1
    ;;
esac

curl -X POST "$BASE_URL$ENDPOINT" \
  -H "Authorization: Bearer $EMPEROR_CLAW_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @"$PAYLOAD_FILE"
