#!/bin/bash
OUTPUT=$(npx tsx --env-file=.env generate_test_token.ts)
TOKEN=$(echo "$OUTPUT" | head -n 1)
AGENT=$(echo "$OUTPUT" | tail -n 1)
echo "Token: $TOKEN"
echo "Agent: $AGENT"
TEST_API_TOKEN=$TOKEN AGENT_ID=$AGENT npx tsx simulate-openclaw.ts
