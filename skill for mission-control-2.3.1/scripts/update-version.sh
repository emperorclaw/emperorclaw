#!/bin/bash
# Update version.json with current git hash and timestamp
# Run this after making changes to the dashboard

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ASSETS_DIR="$SCRIPT_DIR/../assets"
VERSION_FILE="$ASSETS_DIR/data/version.json"

# Get current git hash of index.html
BUILD_HASH=$(cd "$ASSETS_DIR" && git log -1 --format="%h" -- index.html 2>/dev/null || echo "$(date +%s)")
BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Get current version or default
CURRENT_VERSION=$(cat "$VERSION_FILE" 2>/dev/null | grep '"version"' | sed 's/.*: *"\([^"]*\)".*/\1/' || echo "1.0.0")

# Write new version.json
cat > "$VERSION_FILE" << EOF
{
  "version": "$CURRENT_VERSION",
  "buildHash": "$BUILD_HASH",
  "buildTime": "$BUILD_TIME"
}
EOF

echo "✅ Updated version.json"
echo "   Build Hash: $BUILD_HASH"
echo "   Build Time: $BUILD_TIME"
