#!/usr/bin/env sh
# Starts the dev-agent setup for Antigravity. Run it from the folder you want to work in:
#   sh /path/to/dev-agent/setup.sh [--scope global] [--yes]
set -e
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required. Install it, then run this again:"
  echo "  macOS:          brew install node"
  echo "  Ubuntu/Debian:  sudo apt install nodejs npm   (or https://nodejs.org)"
  echo "  Anything else:  https://nodejs.org"
  exit 1
fi
exec node "$here/scripts/setup.mjs" "$@"
