#!/bin/sh
set -eu

api_url="${TASKARA_API_URL:-${VITE_TASKARA_API_URL:-}}"
escaped_api_url="$(printf '%s' "$api_url" | sed 's/\\/\\\\/g; s/"/\\"/g')"

cat > /usr/share/nginx/html/env.js <<EOF
window.__TASKARA_CONFIG__ = {
  TASKARA_API_URL: "$escaped_api_url"
};
EOF
