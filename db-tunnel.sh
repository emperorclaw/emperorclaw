#!/bin/bash
# Opens an SSH tunnel from localhost:5432 → VPS PostgreSQL (212.227.22.193:5432)
# Keep this terminal open while developing locally against the VPS DB.

VPS_IP="212.227.22.193"
VPS_USER="root"
LOCAL_PORT=5432
REMOTE_PORT=5432

echo "🔌 Opening DB tunnel to $VPS_USER@$VPS_IP..."
echo "   Local port $LOCAL_PORT → VPS postgres:$REMOTE_PORT"
echo "   Press Ctrl+C to close."
echo ""

ssh -o StrictHostKeyChecking=no \
    -L ${LOCAL_PORT}:localhost:${REMOTE_PORT} \
    ${VPS_USER}@${VPS_IP} \
    -N
