#!/bin/sh
# One-time, as root (sudo): copies the Bluetooth identity keys (IRKs) of his Apple devices from the
# System keychain (service MobileBluetooth, one item per device address) into
# ~/.config/presence/irks.json (mode 600), so presence/ble.py can recognise his phone and watch behind
# their rotating Bluetooth addresses. Prints only the device addresses and whether a key was found.
set -e
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
user="${SUDO_USER:?run with sudo from his account}"
home=$(dscl . -read "/Users/$user" NFSHomeDirectory | awk '{print $2}')
out="$home/.config/presence/irks.json"
mkdir -p "$(dirname "$out")"
tmp=$(mktemp -d)
security dump-keychain /Library/Keychains/System.keychain 2>/dev/null \
  | awk '/"svce"<blob>="MobileBluetooth"/{m=1} /"acct"<blob>=/{if(m){gsub(/.*="|"$/,""); print; m=0}}' > "$tmp/accts"
while read -r a; do
  security find-generic-password -s MobileBluetooth -a "$a" -w /Library/Keychains/System.keychain > "$tmp/$a.val" 2>/dev/null || true
done < "$tmp/accts"
/usr/bin/python3 - "$tmp" "$out" <<'PY'
import json, os, plistlib, sys, binascii
tmp, out = sys.argv[1], sys.argv[2]
keys = {}
for a in open(os.path.join(tmp, "accts")).read().split():
    raw = open(os.path.join(tmp, a + ".val"), "rb").read().strip()
    try: data = binascii.unhexlify(raw)
    except Exception: data = raw
    # Every 16-byte value with its field name: which one is the remote device's IRK is settled by
    # resolving real adverts (presence/ble.py), not by guessing the plist's naming.
    cands, name = {}, None
    try:
        p = plistlib.loads(data)
        for k, v in (p.items() if isinstance(p, dict) else []):
            if isinstance(v, bytes) and len(v) == 16:
                cands[k] = v.hex()
            elif isinstance(v, str) and len(v.replace("-", "").replace(" ", "")) == 32:
                cands[k] = v.replace("-", "").replace(" ", "").lower()
            if k.lower() in ("name", "devicename") and isinstance(v, str):
                name = v
        fields = sorted(p.keys()) if isinstance(p, dict) else []
    except Exception:
        fields = []
    keys[a] = {"candidates": cands, "fields": fields, "name": name}
    print(a, len(cands), "candidate keys;", "fields:", ", ".join(fields))
json.dump(keys, open(out, "w"))
PY
chown "$user" "$out"; chmod 600 "$out"
rm -r "$tmp"
echo "saved"
