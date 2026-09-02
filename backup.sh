#!/usr/bin/env bash
# Back up every Supabase table to ~/supabase-backups, then mirror that directory to the Pi.
#
# launchd starts jobs with PATH=/usr/bin:/bin:/usr/sbin:/sbin, which does not contain node — the
# agent failed with "exec: node: not found" while the same script ran fine by hand. Widen it here
# rather than in the plist so any caller gets the same behaviour.
set -uo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")" || exit 1
set -a; [ -f .env ] && . ./.env; set +a
DEST="${1:-$HOME/supabase-backups}"

command -v node >/dev/null || { echo "node not found on PATH: $PATH" >&2; exit 127; }
node backup.mjs "$DEST" || exit $?

# Second copy on the Pi. Mirroring the directory rather than sending one file means the Pi inherits
# the same retention for free, so the two never drift apart.
#
# Best-effort on purpose: the Mac cannot always reach the Pi (mDNS is unreliable here), and a
# backup that already succeeded locally must not be reported as failed because the mirror did not
# run. It says which happened either way — silence would be indistinguishable from success.
if rsync -az --delete --exclude 'backup.log' --exclude '.*' \
      -e 'ssh -o ConnectTimeout=10 -o BatchMode=yes' \
      "$DEST/" pi:supabase-backups/ 2>/dev/null; then
  echo "mirrored to pi:~/supabase-backups"
else
  echo "pi mirror FAILED (local copy is fine; Pi copy is now stale)" >&2
fi
