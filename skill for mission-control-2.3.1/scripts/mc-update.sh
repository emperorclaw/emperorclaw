#!/bin/bash
# Mission Control Task Update Script
# Usage: mc-update.sh <command> <task_id> [args...]
#
# Commands:
#   status <task_id> <new_status>       - Update task status (backlog, in_progress, review, done)
#   subtask <task_id> <subtask_id> done - Mark subtask as done
#   comment <task_id> "comment text"    - Add comment to task
#   add-subtask <task_id> "title"       - Add new subtask
#   complete <task_id> "summary"        - Move to review + add completion comment
#   start <task_id>                     - Mark task as being processed (prevents duplicate processing)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
export TASKS_FILE="$REPO_DIR/data/tasks.json"

cd "$REPO_DIR"

# Sanitize input: reject arguments containing characters that could break
# Python string literals or shell commands.
sanitize_input() {
    local val="$1"
    local name="$2"
    # Block backticks and $ to prevent shell/string injection
    if [[ "$val" =~ [\`\$] ]]; then
        echo "✗ Invalid characters in $name" >&2
        exit 1
    fi
}

case "$1" in
    status)
        TASK_ID="$2"
        NEW_STATUS="$3"
        
        if [[ -z "$TASK_ID" || -z "$NEW_STATUS" ]]; then
            echo "Usage: mc-update.sh status <task_id> <new_status>"
            exit 1
        fi
        
        sanitize_input "$TASK_ID" "task_id"
        sanitize_input "$NEW_STATUS" "status"
        
        MC_TASK_ID="$TASK_ID" MC_NEW_STATUS="$NEW_STATUS" python3 -c "
import json, sys, os
tasks_file = os.environ['TASKS_FILE']
task_id = os.environ['MC_TASK_ID']
new_status = os.environ['MC_NEW_STATUS']
with open(tasks_file, 'r', encoding='utf-8') as f:
    data = json.load(f)
found = False
for t in data['tasks']:
    if t['id'] == task_id:
        old_status = t['status']
        t['status'] = new_status
        found = True
        print(f'✓ {t[\"title\"]}: {old_status} → {new_status}')
        break
if not found:
    print(f'✗ Task \"{task_id}\" not found')
    sys.exit(1)
with open(tasks_file, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
" <<< "" 
        ;;
        
    subtask)
        TASK_ID="$2"
        SUBTASK_ID="$3"
        ACTION="$4"
        
        if [[ -z "$TASK_ID" || -z "$SUBTASK_ID" || "$ACTION" != "done" ]]; then
            echo "Usage: mc-update.sh subtask <task_id> <subtask_id> done"
            exit 1
        fi
        
        sanitize_input "$TASK_ID" "task_id"
        sanitize_input "$SUBTASK_ID" "subtask_id"
        
        MC_TASK_ID="$TASK_ID" MC_SUBTASK_ID="$SUBTASK_ID" python3 -c "
import json, sys, os
tasks_file = os.environ['TASKS_FILE']
task_id = os.environ['MC_TASK_ID']
subtask_id = os.environ['MC_SUBTASK_ID']
with open(tasks_file, 'r', encoding='utf-8') as f:
    data = json.load(f)
found = False
for t in data['tasks']:
    if t['id'] == task_id:
        for s in t['subtasks']:
            if s['id'] == subtask_id:
                s['done'] = True
                found = True
                print(f'✓ Subtask \"{s[\"title\"]}\" marked as done')
                break
        break
if not found:
    print('✗ Task or subtask not found')
    sys.exit(1)
with open(tasks_file, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
" <<< ""
        ;;
        
    comment)
        TASK_ID="$2"
        COMMENT_TEXT="$3"
        
        if [[ -z "$TASK_ID" || -z "$COMMENT_TEXT" ]]; then
            echo "Usage: mc-update.sh comment <task_id> \"comment text\""
            exit 1
        fi
        
        sanitize_input "$TASK_ID" "task_id"
        
        MC_TASK_ID="$TASK_ID" MC_COMMENT_TEXT="$COMMENT_TEXT" python3 -c "
import json, sys, os
from datetime import datetime
tasks_file = os.environ['TASKS_FILE']
task_id = os.environ['MC_TASK_ID']
comment_text = os.environ['MC_COMMENT_TEXT']
with open(tasks_file, 'r', encoding='utf-8') as f:
    data = json.load(f)
found = False
for t in data['tasks']:
    if t['id'] == task_id:
        if 'comments' not in t:
            t['comments'] = []
        comment = {
            'id': f'c{len(t[\"comments\"])+1}',
            'author': 'MoltBot',
            'text': comment_text,
            'createdAt': datetime.now().isoformat() + 'Z'
        }
        t['comments'].append(comment)
        found = True
        print(f'✓ Comment added to \"{t[\"title\"]}\"')
        break
if not found:
    print(f'✗ Task \"{task_id}\" not found')
    sys.exit(1)
with open(tasks_file, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
" <<< ""
        ;;
        
    add-subtask)
        TASK_ID="$2"
        SUBTASK_TITLE="$3"
        
        if [[ -z "$TASK_ID" || -z "$SUBTASK_TITLE" ]]; then
            echo "Usage: mc-update.sh add-subtask <task_id> \"subtask title\""
            exit 1
        fi
        
        sanitize_input "$TASK_ID" "task_id"
        
        MC_TASK_ID="$TASK_ID" MC_SUBTASK_TITLE="$SUBTASK_TITLE" python3 -c "
import json, sys, os
tasks_file = os.environ['TASKS_FILE']
task_id = os.environ['MC_TASK_ID']
subtask_title = os.environ['MC_SUBTASK_TITLE']
with open(tasks_file, 'r', encoding='utf-8') as f:
    data = json.load(f)
found = False
for t in data['tasks']:
    if t['id'] == task_id:
        subtask_id = f'sub_{len(t[\"subtasks\"])+1}'
        t['subtasks'].append({
            'id': subtask_id,
            'title': subtask_title,
            'done': False
        })
        found = True
        print(f'✓ Subtask \"{subtask_id}\" added to \"{t[\"title\"]}\"')
        break
if not found:
    print(f'✗ Task \"{task_id}\" not found')
    sys.exit(1)
with open(tasks_file, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
" <<< ""
        ;;
        
    complete)
        TASK_ID="$2"
        SUMMARY="$3"
        
        if [[ -z "$TASK_ID" || -z "$SUMMARY" ]]; then
            echo "Usage: mc-update.sh complete <task_id> \"summary of what was done\""
            exit 1
        fi
        
        sanitize_input "$TASK_ID" "task_id"
        
        MC_TASK_ID="$TASK_ID" MC_SUMMARY="$SUMMARY" python3 -c "
import json, sys, os
from datetime import datetime
tasks_file = os.environ['TASKS_FILE']
task_id = os.environ['MC_TASK_ID']
summary = os.environ['MC_SUMMARY']
with open(tasks_file, 'r', encoding='utf-8') as f:
    data = json.load(f)
found = False
for t in data['tasks']:
    if t['id'] == task_id:
        old_status = t['status']
        t['status'] = 'review'
        # Clear processing flag (stops spinner)
        if 'processingStartedAt' in t:
            del t['processingStartedAt']
        if 'comments' not in t:
            t['comments'] = []
        comment = {
            'id': f'c{len(t[\"comments\"])+1}',
            'author': 'MoltBot',
            'text': summary,
            'createdAt': datetime.now().isoformat() + 'Z'
        }
        t['comments'].append(comment)
        found = True
        print(f'✓ {t[\"title\"]}: {old_status} → review')
        print('✓ Added completion comment')
        break
if not found:
    print(f'✗ Task \"{task_id}\" not found')
    sys.exit(1)
with open(tasks_file, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
" <<< ""
        ;;
        
    start)
        TASK_ID="$2"
        
        if [[ -z "$TASK_ID" ]]; then
            echo "Usage: mc-update.sh start <task_id>"
            exit 1
        fi
        
        sanitize_input "$TASK_ID" "task_id"
        
        MC_TASK_ID="$TASK_ID" python3 -c "
import json, sys, os
from datetime import datetime
tasks_file = os.environ['TASKS_FILE']
task_id = os.environ['MC_TASK_ID']
with open(tasks_file, 'r', encoding='utf-8') as f:
    data = json.load(f)
found = False
for t in data['tasks']:
    if t['id'] == task_id:
        # Check if already being processed
        if t.get('processingStartedAt'):
            print(f'⚠ Task \"{t[\"title\"]}\" is already being processed since {t[\"processingStartedAt\"]}')
            sys.exit(1)
        
        # Set processing timestamp
        now = datetime.now().isoformat() + 'Z'
        t['processingStartedAt'] = now
        
        # Add comment
        if 'comments' not in t:
            t['comments'] = []
        comment = {
            'id': f'c_{int(datetime.now().timestamp()*1000)}',
            'author': 'MoltBot',
            'text': '🤖 Processing started',
            'createdAt': now
        }
        t['comments'].append(comment)
        
        found = True
        print(f'✓ Processing started for \"{t[\"title\"]}\"')
        print(f'✓ processingStartedAt: {now}')
        break
if not found:
    print(f'✗ Task \"{task_id}\" not found')
    sys.exit(1)
with open(tasks_file, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
" <<< ""
        ;;
        
    *)
        echo "Mission Control Task Update Script"
        echo ""
        echo "Usage: mc-update.sh <command> <task_id> [args...]"
        echo ""
        echo "Commands:"
        echo "  status <task_id> <new_status>       - Update task status"
        echo "  subtask <task_id> <subtask_id> done - Mark subtask as done"
        echo "  comment <task_id> \"text\"            - Add comment to task"
        echo "  add-subtask <task_id> \"title\"       - Add new subtask"
        echo "  complete <task_id> \"summary\"        - Move to review + add comment"
        echo "  start <task_id>                     - Mark as being processed (prevents duplicates)"
        exit 1
        ;;
esac

# Auto commit and push if changes were made
if [[ -n "$(git status --porcelain data/tasks.json)" ]]; then
    git add data/tasks.json
    git commit -m "Task update via mc-update.sh: ${1} ${2}"
    git push
    echo "✓ Changes pushed to GitHub"
fi
