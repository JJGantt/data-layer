"""His phone and watch arriving at or leaving home, over Bluetooth (README § Presence).

Both advertise every second or so behind rotating private addresses. On the Mac, which shares his iCloud
account and has both paired, CoreBluetooth resolves those itself: with bleak's `use_bdaddr` the scan
reports them under their real Bluetooth addresses (Settings > General > About > Bluetooth), measured
2026-11-27, so no identity key is needed here. A machine without that pairing (the Pi) would need their
IRKs instead (presence/read-ble-irks.sh); not built yet.

A device unheard for AWAY_S is away; the next advert from it is an arrival. Each change is one row in
`presence_events` (migration 00217); the hub acts on arrivals. Runs under door/bin/door-launch, which
holds the Mac's Bluetooth grant.
"""
import asyncio
import json
import logging
import os
import time
import urllib.request

import ops_report as ops
from bleak import BleakScanner

MACHINE = os.environ.get("OPS_MACHINE") or ("mac" if os.uname().sysname == "Darwin" else "pi")
# Real Bluetooth addresses, from each device's Settings > General > About > Bluetooth.
DEVICES = {"2C:57:CE:14:03:5B": "phone", "10:A4:C9:16:61:6A": "watch"}
# Short: whether a silence means he left is decided by the hub, which also requires the door to
# have opened first (status-hub lib/door.js leftAndCameBack). Both are heard every few seconds at home.
AWAY_S = 30
GAP_LOG_S = 15
BEAT_S = 60
log = logging.getLogger("presence-ble")


def load_env():
    p = os.path.join(os.path.dirname(__file__), "..", ".env")
    try:
        for line in open(p):
            t = line.strip()
            if t and not t.startswith("#") and "=" in t:
                k, v = t.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
    except FileNotFoundError:
        pass


def store(row):
    url = os.environ["SUPABASE_URL"] + "/rest/v1/presence_events"
    key = os.environ["SUPABASE_KEY"]
    req = urllib.request.Request(url, data=json.dumps(row).encode(), method="POST", headers={
        "apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json", "Prefer": "return=minimal"})
    urllib.request.urlopen(req, timeout=15).read()


def event(device, kind, rssi=None, away_s=None):
    row = {"machine": MACHINE, "device": device, "source": "ble", "event": kind, "rssi": rssi, "away_s": away_s}
    log.info("%s %s rssi=%s away=%ss", device, kind, rssi, away_s)
    try:
        store(row)
    except Exception:
        log.exception("storing a presence event failed")


async def listen():
    # name -> last time heard; a device not heard yet since start counts as unknown, not away, so a
    # restart never reads as an arrival.
    last: dict[str, float] = {}
    away: set[str] = set()

    def cb(d, adv):
        name = DEVICES.get(d.address.upper())
        if not name:
            return
        now = time.monotonic()
        if name in away:
            away.discard(name)
            event(name, "arrive", adv.rssi, int(now - last[name]))
        elif name in last and now - last[name] >= GAP_LOG_S:
            # Shorter than an absence, but worth seeing when tuning AWAY_S.
            log.info("%s heard again after %ds (rssi %s)", name, int(now - last[name]), adv.rssi)
        last[name] = now

    scanner = BleakScanner(cb, cb={"use_bdaddr": True})
    await scanner.start()
    try:
        while True:
            await asyncio.sleep(5)
            now = time.monotonic()
            for name, t in last.items():
                if name not in away and now - t > AWAY_S:
                    away.add(name)
                    event(name, "leave", None, None)
            ops.beat(BEAT_S * 2)
    finally:
        await scanner.stop()


async def main():
    load_env()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    ops.install(machine=MACHINE, service="presence-ble")
    delay, reported = 5, False
    while True:
        started = time.monotonic()
        try:
            await listen()
        except Exception as e:
            if time.monotonic() - started > 120:
                delay, reported = 5, False
            if not reported:
                log.error("Bluetooth presence scanning failed: %s; retrying with backoff", e)
                reported = True
            await asyncio.sleep(delay)
            delay = min(delay * 2, 600)


if __name__ == "__main__":
    asyncio.run(main())
