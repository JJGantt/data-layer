#!/usr/bin/env bash
# Apply migrations to Supabase, from whichever machine wrote them.
#
# Replaced a GitHub Actions workflow on 2026-08-26 for the same reason as the hub's deploy: Actions
# added a dependency on GitHub being healthy and an out-of-order replay hazard, in exchange for
# nothing this needs. Both the Mac and the Pi have the CLI authenticated and the project linked.
set -uo pipefail
cd "$(dirname "$0")" || exit 1
echo y | supabase db push
supabase migration list
