#!/bin/sh
# One-time, as root (sudo): lets members of `admin` read packets, so presence/listener.py can hear the
# phone and the watch join the home network without running as root. Installs a LaunchDaemon that
# reapplies it at every boot, because /dev/bpf* are recreated root-only. Reverse with
#   sudo launchctl bootout system/com.jaredgantt.capture-access; sudo rm /Library/LaunchDaemons/com.jaredgantt.capture-access.plist
set -e
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
cat > /Library/LaunchDaemons/com.jaredgantt.capture-access.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.jaredgantt.capture-access</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string>
    <string>chgrp admin /dev/bpf*; chmod g+rw /dev/bpf*</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST
chown root:wheel /Library/LaunchDaemons/com.jaredgantt.capture-access.plist
chmod 644 /Library/LaunchDaemons/com.jaredgantt.capture-access.plist
launchctl bootout system/com.jaredgantt.capture-access 2>/dev/null || true
launchctl bootstrap system /Library/LaunchDaemons/com.jaredgantt.capture-access.plist
sleep 1
ls -l /dev/bpf0
echo "capture access installed"
