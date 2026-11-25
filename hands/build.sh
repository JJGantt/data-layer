#!/usr/bin/env bash
# Builds the Mac's handoff helpers into data-layer/hands/bin (gitignored).
#
# hands-launch holds the macOS grants (Screen Recording and Accessibility) for everything it starts, and a
# grant is tied to the binary's signature: rebuilding hands-launch VOIDS its grants, so it is built only
# when missing. `hands` itself needs no grant of its own (it runs as hands-launch's descendant) and is
# rebuilt every time.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
[ -x bin/hands-launch ] || clang -O2 -Wall -o bin/hands-launch hands-launch.c
swiftc -O -o bin/hands hands.swift
echo "built $(pwd)/bin"
