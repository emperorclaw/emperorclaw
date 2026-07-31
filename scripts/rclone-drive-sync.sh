#!/bin/sh
set -eu

remote_name="${DRIVE_RCLONE_REMOTE:-gdrive}"
remote_root="${DRIVE_ROOT:-Emperor-Claw}"
interval="${DRIVE_POLL_INTERVAL_SECONDS:-5}"
local_root="${DRIVE_LOCAL_ROOT:-/storage/companies}"
remote_path="${remote_name}:${remote_root}/companies"

case "$interval" in
  ''|*[!0-9]*) echo "DRIVE_POLL_INTERVAL_SECONDS must be an integer" >&2; exit 2 ;;
esac

if [ "$interval" -lt 2 ]; then
  echo "DRIVE_POLL_INTERVAL_SECONDS must be at least 2" >&2
  exit 2
fi

echo "Drive mirror enabled: ${local_root} <-> ${remote_path} (${interval}s)"

# Create the remote root once so a first-time installation does not emit a
# three-attempt "directory not found" error before the initial outbound pass.
rclone mkdir "$remote_path" || echo "Unable to create Drive mirror root; retrying in the sync loop" >&2

while true; do
  # Drive edits arrive first. --update prevents an older remote version from
  # replacing a newer local write. Copy never propagates deletions.
  rclone copy "$remote_path" "$local_root" \
    --update \
    --create-empty-src-dirs \
    --exclude ".*" \
    --exclude "~$*" \
    --exclude "*.partial" \
    --exclude "*.tmp" || echo "Drive inbound pass failed; retrying" >&2

  # Emperor writes are then made visible in Drive. Rclone's default transfer
  # behavior uses partial files rather than overwriting a destination in place.
  rclone copy "$local_root" "$remote_path" \
    --update \
    --create-empty-src-dirs \
    --exclude ".*" \
    --exclude "~$*" \
    --exclude "*.partial" \
    --exclude "*.tmp" || echo "Drive outbound pass failed; retrying" >&2

  sleep "$interval"
done
