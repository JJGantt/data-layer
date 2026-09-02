#!/usr/bin/env bash
# Back up every Supabase table to ~/supabase-backups. See backup.mjs for what is and isn't covered.
set -uo pipefail
cd "$(dirname "$0")" || exit 1
set -a; [ -f .env ] && . ./.env; set +a
exec node backup.mjs "${1:-$HOME/supabase-backups}"
