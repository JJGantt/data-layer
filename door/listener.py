"""The front door over Bluetooth (README § The front door).

The SwitchBot Lock Ultra advertises its state continuously: lock status, door open/closed (the frame
magnet) and battery are in its manufacturer data in the clear, no key needed. This listens passively,
and on each changed advertisement calls the Supabase function door_report() (migrations 00208, 00209), which
decides whether anything changed and writes door_events / device_status. Any number of machines near
the door can run this at once; the function's lock and the advert sequence byte make them write once.

Manufacturer data (company 2409), as pySwitchbot's process_lock2 reads the Lock Ultra:
  [0:6] MAC   [6] sequence (bumps on a change)   [7] bit7 calibrated, bits 6-3 status
  [8] bit4 door open   [9] bits 6-0 battery %
Status: 0 locked, 1 unlocked, 2 locking, 3 unlocking, 4/5 jammed (locking/unlocking blocked),
6/7 partly locked (EU only). The moving states are not recorded; the settled one after them is.
"""
import asyncio
import json
import logging
import os
import socket
import time
import urllib.request

import ops_report as ops
from bleak import BleakScanner

LOCK_MAC = os.environ.get("DOOR_LOCK_MAC", "b0:e9:fe:e7:2f:47").lower()
MACHINE = os.environ.get("OPS_MACHINE") or ("mac" if os.uname().sysname == "Darwin" else "pi")
# Measured: the lock advertises every second or two. This long without one means the radio, the lock's
# battery, or this machine's Bluetooth is not working.
SILENT_S = 300
BEAT_S = 60

log = logging.getLogger("door")
STATUS = {0: "locked", 1: "unlocked", 4: "jammed", 5: "jammed"}


def load_env():
    for p in (os.path.join(os.path.dirname(__file__), "..", ".env"),):
        try:
            for line in open(p):
                t = line.strip()
                if t and not t.startswith("#") and "=" in t:
                    k, v = t.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())
        except FileNotFoundError:
            pass


def parse(m: bytes):
    """The lock's state from its manufacturer data, or None for a moving or unknown status."""
    if len(m) < 12:
        return None
    status = (m[7] & 0b01111000) >> 3
    return {
        "seq": m[6],
        "lock": STATUS.get(status),
        "status": status,
        "door": "opened" if m[8] & 0b00010000 else "closed",
        "battery": m[9] & 0b01111111,
        "calibrated": bool(m[7] & 0b10000000),
    }


def report(s, raw_hex):
    url = os.environ.get("SUPABASE_URL", "https://felyggqjjhltwokdfhop.supabase.co") + "/rest/v1/rpc/door_report"
    key = os.environ["SUPABASE_KEY"]
    body = json.dumps({"p_source": "ble", "p_lock": s["lock"], "p_door": s["door"], "p_seq": s["seq"], "p_battery": s["battery"],
                       "p_machine": MACHINE, "p_raw": {"mfr": raw_hex, "status": s["status"], "host": socket.gethostname()}}).encode()
    req = urllib.request.Request(url, body, method="POST", headers={
        "apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


async def listen(q, last):
    """Scan until the scanner fails; adverts go on `q`. Returns only by raising."""
    def cb(_device, adv):
        m = adv.manufacturer_data.get(2409)
        if not m or m[:6].hex(":") != LOCK_MAC:
            return
        last["heard"] = time.monotonic()
        key = m[6:10]
        if key != last["key"]:
            last["key"] = key
            q.put_nowait(bytes(m))

    async with BleakScanner(cb):
        log.info("listening for %s", LOCK_MAC)
        silent_reported = False
        while True:
            try:
                m = await asyncio.wait_for(q.get(), timeout=BEAT_S)
            except asyncio.TimeoutError:
                m = None
            gap = time.monotonic() - last["heard"]
            if gap > SILENT_S:
                if not silent_reported:
                    log.error("no advertisement from the front door lock for %ds", int(gap))
                    silent_reported = True
            else:
                silent_reported = False
                ops.beat(BEAT_S * 2)
            if m is None:
                continue
            s = parse(m)
            if not s or not s["lock"]:
                log.info("advert %s (moving or unknown status), not recorded", m.hex())
                continue
            try:
                rows = report(s, m.hex())
                log.info("seq %d %s door %s battery %d%% -> %s", s["seq"], s["lock"], s["door"], s["battery"],
                         [r["event"] for r in rows] or "no change")
            except Exception:
                log.exception("door_report failed")
                last["key"] = None  # retry on the next advert


async def main():
    load_env()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    ops.install(machine=MACHINE, service="door-listener")
    q: asyncio.Queue = asyncio.Queue()
    last = {"key": None, "heard": time.monotonic()}
    # Bluetooth off, or not granted to this process ("Bluetooth device is turned off" is also what
    # CoreBluetooth answers when the grant is missing): reported once per outage, retried with backoff
    # up to ten minutes, never a crash loop.
    delay, down_reported = 5, False
    while True:
        started = time.monotonic()
        try:
            await listen(q, last)
        except Exception as e:
            if time.monotonic() - started > 120:
                delay, down_reported = 5, False   # it ran; this is a new outage
            if not down_reported:
                log.error("Bluetooth scanning failed: %s; retrying with backoff", e)
                down_reported = True
            else:
                log.info("Bluetooth still unavailable (%s); next try in %ds", e, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 600)


if __name__ == "__main__":
    asyncio.run(main())
