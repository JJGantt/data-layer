#!/bin/sh
# One-time, as root (sudo): copies the Bluetooth identity keys (IRKs) of his phone and watch into
# ~/.config/presence/irks.json (mode 600) for presence/ble.py. Each device's entry is in the System
# keychain, service BluetoothLE, account "Public <its Bluetooth address> Random …"; its value is a plist
# whose "Remote IRK" is the key. The address is the one Settings > General > About > Bluetooth shows.
# Usage: sudo sh read-ble-irks.sh phone=2C:57:CE:14:03:5B watch=10:A4:C9:16:61:6A
# Prints only names and whether a key was found.
set -e
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
user="${SUDO_USER:?run with sudo from his account}"
home=$(dscl . -read "/Users/$user" NFSHomeDirectory | awk '{print $2}')
out="$home/.config/presence/irks.json"
mkdir -p "$(dirname "$out")"
tmp=$(mktemp -d)
for pair in "$@"; do
  name=${pair%%=*}; addr=${pair#*=}
  acct=$(security dump-keychain /Library/Keychains/System.keychain 2>/dev/null \
    | sed -n "s/.*\"acct\"<blob>=\"\(Public $addr Random [^\"]*\)\".*/\1/p" | head -1)
  [ -n "$acct" ] || { echo "$name: no entry for $addr"; continue; }
  security find-generic-password -s BluetoothLE -a "$acct" -w /Library/Keychains/System.keychain > "$tmp/$name" 2>/dev/null \
    || echo "$name: could not read the entry"
done
/usr/bin/python3 - "$tmp" "$out" "$@" <<'PY'
import binascii, json, os, plistlib, sys
tmp, out, pairs = sys.argv[1], sys.argv[2], sys.argv[3:]
keys = {}
for pair in pairs:
    name, addr = pair.split("=", 1)
    p = os.path.join(tmp, name)
    if not os.path.exists(p) or not os.path.getsize(p):
        continue
    raw = open(p, "rb").read().strip()
    try: data = binascii.unhexlify(raw)
    except Exception: data = raw
    irk = plistlib.loads(data).get("Remote IRK")
    print(name, "key found" if irk else "no Remote IRK in the entry")
    if irk: keys[name] = {"address": addr, "irk": irk.hex()}
json.dump(keys, open(out, "w"))
PY
chown "$user" "$out"; chmod 600 "$out"
rm -r "$tmp"
echo "saved"
