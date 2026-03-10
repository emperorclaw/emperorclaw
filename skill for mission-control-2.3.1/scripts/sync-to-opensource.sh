#!/bin/bash
# sync-to-opensource.sh - Export sanitized crons.json for open source repo
# Removes sensitive data like API keys, channel IDs, and personal info

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS_DIR="$SCRIPT_DIR/../assets"
OUTPUT_FILE="$ASSETS_DIR/data/crons-example.json"

# Create sanitized example crons.json
cat > "$OUTPUT_FILE" << 'EOF'
{
  "lastUpdated": "2026-01-30T14:00:00Z",
  "crons": [
    {
      "id": "example-daily-report",
      "name": "Daily Report",
      "emoji": "📊",
      "schedule": "0 9 * * *",
      "enabled": true,
      "lastStatus": "ok",
      "lastRunAt": 1769756400000,
      "nextRunAt": 1769842800000
    },
    {
      "id": "example-weekly-check",
      "name": "Weekly Check",
      "emoji": "📅",
      "schedule": "0 8 * * 1",
      "enabled": true,
      "lastStatus": "ok",
      "lastRunAt": 1769410800000,
      "nextRunAt": 1770015600000
    },
    {
      "id": "example-reminder",
      "name": "Example Reminder",
      "emoji": "🔔",
      "schedule": "30 14 * * *",
      "enabled": false,
      "lastStatus": null,
      "lastRunAt": null,
      "nextRunAt": 1769867400000
    }
  ]
}
EOF

echo "✅ Sanitized crons exported to $OUTPUT_FILE"
echo "   You can commit this to the open source repo."
