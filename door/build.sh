#!/usr/bin/env bash
# Builds door-launch (gitignored), the binary that holds the Mac's Bluetooth grant for the listener.
# A grant is tied to the signature: signed with the login keychain's development identity, one Allow
# lasts across rebuilds; built only when missing all the same. The venv is the listener's packages.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
if [ ! -x bin/door-launch ]; then
  clang -O2 -Wall -sectcreate __TEXT __info_plist Info.plist -o bin/door-launch door-launch.c
  ID=$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development: .*\)"/\1/p' | head -1)
  codesign -f -s "${ID:--}" -i com.jaredgantt.door-launch bin/door-launch
fi
[ -x .venv/bin/python ] || { uv venv -q .venv && uv pip install -q -p .venv/bin/python -r requirements.txt; }
echo "built $(pwd)/bin/door-launch"
