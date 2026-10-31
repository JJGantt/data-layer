#!/usr/bin/env bash
# Restart the life-data Postgres through the Supabase management API, then wait for it to answer.
# For when the project reports ACTIVE_HEALTHY but its db service is UNHEALTHY and REST returns 522.
set -uo pipefail
REF=felyggqjjhltwokdfhop
TOK=$(security find-generic-password -s "Supabase CLI" -w | sed 's/^go-keyring-base64://' | base64 -d)
API="https://api.supabase.com/v1/projects/$REF"
curl -s -m 60 -X POST "$API/restart" -H "Authorization: Bearer $TOK" -w "restart requested: HTTP %{http_code}\n"
for i in $(seq 1 60); do
  sleep 10
  h=$(curl -s -m 20 "$API/health?services=db&services=rest" -H "Authorization: Bearer $TOK")
  echo "$(date +%H:%M:%S) $h" | cut -c1-160
  echo "$h" | grep -q '"name":"db","healthy":true' && echo "$h" | grep -q '"name":"rest","healthy":true' && { echo "database back"; exit 0; }
done
echo "still unhealthy after 10 minutes"; exit 1
