#!/bin/sh
set -eu

remote_name="${DRIVE_RCLONE_REMOTE:-gdrive}"
remote_root="${DRIVE_ROOT:-Emperor-Claw}"
interval="${DRIVE_POLL_INTERVAL_SECONDS:-5}"
local_root="${DRIVE_LOCAL_ROOT:-/storage/companies}"
remote_path="${remote_name}:${remote_root}/companies"
delete_queue="${DRIVE_DELETE_QUEUE_DIR:-/storage/.drive-sync/deletions}"

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

process_delete_markers() {
  file_queue="${delete_queue}/files"
  directory_queue="${delete_queue}/directories"

  # File markers contain paths relative to the mirrored `companies` root.
  # --files-from-raw makes deletion exact and idempotent: a missing remote
  # file is a successful no-op, while unrelated Drive uploads are untouched.
  if [ -d "$file_queue" ]; then
    for marker in "$file_queue"/*; do
      [ -f "$marker" ] || continue
      relative_path="$(sed -n '1p' "$marker")"
      case "$relative_path" in
        ''|/*|../*|*/../*|*/..|./*|*/./*|*/.)
          echo "Ignoring invalid Drive file deletion marker: ${marker}" >&2
          continue
          ;;
      esac
      # A previous inbound pass may have restored the stale object during the
      # short gap between the application's unlink and marker creation. Remove
      # only the tombstoned local path so the outbound pass cannot revive it.
      rm -f -- "${local_root}/${relative_path}"
      if rclone delete "$remote_path" --files-from-raw "$marker"; then
        rm -f "$marker"
      else
        echo "Drive file deletion failed for ${relative_path}; retrying" >&2
      fi
    done
  fi

  # Directory markers are emitted only after Emperor removes the corresponding
  # local directory. Google Drive's default behavior moves purged content to
  # Trash, keeping operator recovery possible.
  if [ -d "$directory_queue" ]; then
    for marker in "$directory_queue"/*; do
      [ -f "$marker" ] || continue
      relative_path="$(sed -n '1p' "$marker")"
      case "$relative_path" in
        ''|/*|../*|*/../*|*/..|./*|*/./*|*/.)
          echo "Ignoring invalid Drive directory deletion marker: ${marker}" >&2
          continue
          ;;
      esac
      rm -rf -- "${local_root}/${relative_path}"
      if rclone purge "${remote_path}/${relative_path}"; then
        rm -f "$marker"
      else
        status=$?
        if [ "$status" -eq 3 ] || [ "$status" -eq 4 ]; then
          rm -f "$marker"
        else
          echo "Drive directory deletion failed for ${relative_path}; retrying" >&2
        fi
      fi
    done
  fi
}

while true; do
  # Explicit Emperor deletions win before the inbound copy can resurrect a
  # stale Drive object. Drive-originated deletions still do not touch local data.
  process_delete_markers

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
