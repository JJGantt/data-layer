"""Devices joining the home network, heard from the house (docs: data-layer README § Presence).

A phone or watch that joins (or rejoins) a Wi-Fi network sends a DHCP message, broadcast to the whole
LAN, before it can use it. This runs tcpdump on that traffic and writes each message to `lan_joins`
(migration 00214): an event, not a poll. Run on the Mac and the Pi; both write, and each row names its
machine. On the Mac, reading packets needs presence/install-capture-access.sh, run once with sudo.
"""
import json
import logging
import os
import re
import subprocess
import threading
import time
import urllib.request

import ops_report as ops

MACHINE = os.environ.get("OPS_MACHINE") or ("mac" if os.uname().sysname == "Darwin" else "pi")
IFACE = os.environ.get("PRESENCE_IFACE") or ("en0" if MACHINE == "mac" else "wlan0")
BEAT_S = 60
log = logging.getLogger("presence")


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


def parse(block: str):
    """One DHCP packet from tcpdump -vvv -e output, or None when it carries no client address."""
    mac = re.search(r"Client-Ethernet-Address ([0-9a-f:]{17})", block)
    if not mac:
        return None
    ip = (re.search(r"Requested-IP[^:]*: ([\d.]+)", block) or re.search(r"Client-IP ([\d.]+)", block)
          or re.search(r"Your-IP ([\d.]+)", block))
    host = re.search(r'Hostname[^:]*: "([^"]*)"', block)
    msg = re.search(r"DHCP-Message[^:]*: (\w+)", block)
    vendor = re.search(r'Vendor-Class[^:]*: "([^"]*)"', block)
    return {"mac": mac.group(1), "ip": ip.group(1) if ip else None, "hostname": host.group(1) if host else None,
            "message": msg.group(1) if msg else None, "vendor": vendor.group(1) if vendor else None}


def store(row):
    url = os.environ["SUPABASE_URL"] + "/rest/v1/lan_joins"
    key = os.environ["SUPABASE_KEY"]
    req = urllib.request.Request(url, data=json.dumps(row).encode(), method="POST", headers={
        "apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json", "Prefer": "return=minimal"})
    urllib.request.urlopen(req, timeout=15).read()


def run_once():
    # -l line-buffered; a packet's lines start with a timestamp, its continuation lines with whitespace.
    p = subprocess.Popen(["/usr/sbin/tcpdump" if MACHINE == "mac" else "tcpdump", "-l", "-n", "-e", "-vvv", "-i", IFACE,
                          "udp port 67 or udp port 68"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    # DHCP is rare, so the beat comes from a timer while tcpdump is alive, not from the traffic.
    def beat():
        while p.poll() is None:
            ops.beat(BEAT_S * 2)
            time.sleep(BEAT_S)
    threading.Thread(target=beat, daemon=True).start()
    block = ""
    for line in p.stdout:
        if line[:1].isdigit() and block:
            handle(block)
            block = ""
        block += line
    if block:
        handle(block)
    err = p.stderr.read().strip()
    raise RuntimeError(f"tcpdump exited {p.wait()}: {err[-300:]}")


def handle(block):
    row = parse(block)
    if not row:
        return
    row.update(machine=MACHINE, raw=block[:2000])
    log.info("%s %s %s %s", row["message"], row["mac"], row["ip"], row["hostname"])
    try:
        store(row)
    except Exception:
        log.exception("storing a LAN join failed")


def main():
    load_env()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    ops.install(machine=MACHINE, service="presence-listener")
    delay, reported = 5, False
    while True:
        started = time.monotonic()
        try:
            run_once()
        except Exception as e:
            if time.monotonic() - started > 120:
                delay, reported = 5, False
            if not reported:
                log.error("packet capture failed: %s; retrying with backoff", e)
                reported = True
            time.sleep(delay)
            delay = min(delay * 2, 600)


if __name__ == "__main__":
    main()
