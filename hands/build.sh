#!/usr/bin/env bash
# Builds the Mac's handoff and screen-share helpers into data-layer/hands/bin (gitignored).
#
# hands-launch holds the macOS grants (Screen Recording and Accessibility) for everything it starts, and a
# grant is tied to the binary's signature: rebuilding hands-launch VOIDS its grants, so it is built only
# when missing. `hands` and `screenshare` need no grant of their own (they run as hands-launch's
# descendants) and are rebuilt every time.
#
# screenshare links Google's WebRTC (the macOS slice of stasel/WebRTC's prebuilt framework, pinned below),
# fetched into hands/vendor once and copied beside the binary, which finds it through its rpath.
set -euo pipefail
cd "$(dirname "$0")"
WEBRTC=158.0.0
mkdir -p bin vendor
[ -x bin/hands-launch ] || clang -O2 -Wall -o bin/hands-launch hands-launch.c
swiftc -O -o bin/hands hands.swift
if [ "$(cat vendor/WebRTC.version 2>/dev/null)" != "$WEBRTC" ]; then
  rm -rf vendor/WebRTC.framework vendor/x && mkdir vendor/x
  curl -fsSL -o vendor/x/w.zip "https://github.com/stasel/WebRTC/releases/download/$WEBRTC/WebRTC-M${WEBRTC%%.*}.xcframework.zip"
  unzip -q vendor/x/w.zip -d vendor/x
  mv vendor/x/WebRTC.xcframework/macos-x86_64_arm64/WebRTC.framework vendor/
  rm -rf vendor/x && echo "$WEBRTC" > vendor/WebRTC.version
fi
rm -rf bin/WebRTC.framework && cp -R vendor/WebRTC.framework bin/
swiftc -O -swift-version 5 -F vendor -framework WebRTC -Xlinker -rpath -Xlinker @executable_path -o bin/screenshare screenshare.swift
echo "built $(pwd)/bin"
