#!/usr/bin/env bash
# Back up every Supabase table to ~/supabase-backups. See backup.mjs for what is and isn't covered.
#
# launchd starts jobs with PATH=/usr/bin:/bin:/usr/sbin:/sbin, which does not contain node — the
# agent failed with "exec: node: not found" while the same script ran fine by hand. Widen it here
# rather than in the plist so any caller gets the same behaviour.
set -uo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")" || exit 1
set -a; [ -f .env ] && . ./.env; set +a
command -v node >/dev/null || { echo "node not found on PATH: $PATH" >&2; exit 127; }
exec node backup.mjs "${1:-$HOME/supabase-backups}"
