import type { Project, User, Workspace } from '@taskara/db';

const statusOptions = [
  { title: 'برای انجام (پیش فرض)', value: 'TODO' },
  { title: 'بک لاگ', value: 'BACKLOG' },
  { title: 'در حال انجام', value: 'IN_PROGRESS' },
  { title: 'در بازبینی', value: 'IN_REVIEW' },
  { title: 'مسدود', value: 'BLOCKED' },
  { title: 'انجام شد', value: 'DONE' },
  { title: 'لغو شد', value: 'CANCELED' }
];

export interface TaskaraRaycastScriptInput {
  apiUrl: string;
  authToken: string;
  project: Pick<Project, 'id' | 'name' | 'keyPrefix'>;
  user: Pick<User, 'id' | 'name' | 'email'>;
  workspace: Pick<Workspace, 'slug'>;
}

export function buildTaskaraCreateTaskRaycastScript(input: TaskaraRaycastScriptInput): string {
  const argument2 = JSON.stringify({
    type: 'dropdown',
    placeholder: 'برای انجام',
    data: statusOptions,
    optional: true,
    default: 'TODO'
  });

  return `#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title taskara
# @raycast.mode compact

# Optional parameters:
# @raycast.packageName Taskara
# @raycast.argument1 {"type":"text","placeholder":"عنوان تسک","optional":false}
# @raycast.argument2 ${argument2}
# @raycast.description Create a Taskara task in ${input.project.name}

set -euo pipefail

API_URL=${shellString(new URL('/sync/push', input.apiUrl).toString())}
AUTH_TOKEN=${shellString(input.authToken)}
WORKSPACE_SLUG=${shellString(input.workspace.slug)}
CLIENT_ID=${shellString(`raycast-${input.workspace.slug}-${input.user.id}`)}
PROJECT_ID=${shellString(input.project.id)}
ASSIGNEE_ID=${shellString(input.user.id)}
PRIORITY="NO_PRIORITY"
SOURCE="WEB"

TITLE="$(printf '%s' "\${1:-}" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
SELECTED_STATUS="\${2:-TODO}"

case "$SELECTED_STATUS" in
  BACKLOG|TODO|IN_PROGRESS|IN_REVIEW|BLOCKED|DONE|CANCELED) ;;
  "")
    SELECTED_STATUS="TODO"
    ;;
  *)
    echo "Error: وضعیت نامعتبر است. فقط یکی از این‌ها مجاز است: BACKLOG, TODO, IN_PROGRESS, IN_REVIEW, BLOCKED, DONE, CANCELED"
    exit 1
    ;;
esac

if [[ -z "$TITLE" ]]; then
  echo "Error: عنوان تسک خالی است. مثال: taskara ایجاد داشبورد پنل"
  exit 1
fi

MUTATION_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
CREATED_AT="$(python3 - <<'PY'
from datetime import datetime, timezone
print(datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"))
PY
)"

PAYLOAD="$(python3 - <<'PY' "$CLIENT_ID" "$MUTATION_ID" "$PROJECT_ID" "$TITLE" "$ASSIGNEE_ID" "$SELECTED_STATUS" "$PRIORITY" "$SOURCE" "$CREATED_AT"
import json
import sys

client_id, mutation_id, project_id, title, assignee_id, status, priority, source, created_at = sys.argv[1:10]

payload = {
    "clientId": client_id,
    "mutations": [
        {
            "mutationId": mutation_id,
            "name": "task.create",
            "args": {
                "projectId": project_id,
                "title": title,
                "status": status,
                "priority": priority,
                "assigneeId": assignee_id,
                "labels": [],
                "source": source,
            },
            "createdAt": created_at,
        }
    ],
}

print(json.dumps(payload, ensure_ascii=False))
PY
)"

RESPONSE_FILE="$(mktemp "/tmp/taskara-response.XXXXXX")"
trap 'rm -f "$RESPONSE_FILE"' EXIT

HTTP_CODE="$(curl -sS -o "$RESPONSE_FILE" -w "%{http_code}" \\
  -X POST "$API_URL" \\
  -H "Authorization: Bearer $AUTH_TOKEN" \\
  -H "x-workspace-slug: $WORKSPACE_SLUG" \\
  -H "Content-Type: application/json" \\
  --data "$PAYLOAD" || true)"

if [[ "$HTTP_CODE" -lt 200 || "$HTTP_CODE" -ge 300 ]]; then
  echo "Task creation failed (HTTP $HTTP_CODE)"
  cat "$RESPONSE_FILE"
  exit 1
fi

echo "Task created: $TITLE"
`;
}

export function buildTaskaraOpenRaycastScript(appUrl: string): string {
  return `#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title open
# @raycast.mode silent

# Optional parameters:
# @raycast.packageName Taskara
# @raycast.description Open Taskara in default browser

set -euo pipefail

open ${shellString(appUrl)}
`;
}

function shellString(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
