#!/usr/bin/env python3
# Kiosk health watchdog (replaces the old dmesg-OOM-count script, which silently missed kills whenever
# the kernel ring buffer rolled over — exactly what left the wall frozen for hours on 2026-06-27).
#
# It polls the /tv page's RENDERER over the CDP port and reloads only on real, observed breakage:
#   · 'ok'      — renderer alive AND the dashboard rows are painted        -> do nothing
#   · 'broken'  — page target exists but the renderer won't run JS (Aw-snap / hung / blank) -> reload
#   · 'absent'  — no /tv target at all (chromium down or starting)         -> do NOT reload; the
#                 .xinitrc relaunch loop owns that case (avoids fighting a fresh tab mid-load)
# Plus a MemAvailable backstop. Gates on actual state, never a blind timer. A reload = `pkill chromium`;
# the .xinitrc `while` loop then relaunches a fresh tab.
import time, json, subprocess, urllib.request, asyncio
try:
    import websockets
except Exception:
    websockets = None

PORT = 9222
CHECK_EVERY = 20        # seconds between health checks
FAILS_TO_RELOAD = 3     # consecutive 'broken' checks before reloading (ride out transients)
RELOAD_GRACE = 35       # seconds to let a fresh tab paint after X-start / a reload before judging it
LOW_MEM_MB = 400        # MemAvailable backstop

def log(msg):
    try: subprocess.run(["logger", "-t", "kiosk-health", msg], timeout=5)
    except Exception: pass

def mem_avail_mb():
    try:
        for line in open("/proc/meminfo"):
            if line.startswith("MemAvailable"):
                return int(line.split()[1]) // 1024
    except Exception: pass
    return 10**9

def reload_kiosk(reason):
    log(f"{reason} -- reloading kiosk")
    try: subprocess.run(["pkill", "-f", "chromium"], timeout=10)
    except Exception: pass

async def _probe():
    raw = urllib.request.urlopen(f"http://localhost:{PORT}/json", timeout=5).read()
    tgt = next((t for t in json.loads(raw)
                if t.get("type") == "page" and "/tv" in (t.get("url") or "")), None)
    if not tgt or not tgt.get("webSocketDebuggerUrl"):
        return "absent"
    try:
        async with websockets.connect(tgt["webSocketDebuggerUrl"], max_size=None,
                                      open_timeout=5, close_timeout=3, ping_interval=None) as ws:
            await ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                "params": {"expression": "(document.querySelectorAll('.rows>*').length||0)",
                           "returnByValue": True}}))
            while True:
                m = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                if m.get("id") == 1:
                    v = m.get("result", {}).get("result", {}).get("value")
                    return "ok" if isinstance(v, (int, float)) and v > 0 else "broken"
    except Exception:
        return "broken"   # target is listed but the renderer won't respond = Aw-snap / hung

def probe():
    try:
        return asyncio.run(asyncio.wait_for(_probe(), timeout=12))
    except Exception:
        return "absent"

def main():
    if websockets is None:
        log("websockets missing — page health check disabled, low-mem backstop only")
    fails = 0
    time.sleep(RELOAD_GRACE)   # let the wall come up after X start before judging
    while True:
        avail = mem_avail_mb()
        if avail < LOW_MEM_MB:
            reload_kiosk(f"low mem {avail}MB"); fails = 0; time.sleep(RELOAD_GRACE); continue
        state = probe() if websockets else "ok"
        if state == "broken":
            fails += 1
            log(f"page unhealthy ({fails}/{FAILS_TO_RELOAD})")
            if fails >= FAILS_TO_RELOAD:
                reload_kiosk("page unhealthy"); fails = 0; time.sleep(RELOAD_GRACE); continue
        else:
            fails = 0   # 'ok', or 'absent' (chromium relaunching on its own)
        time.sleep(CHECK_EVERY)

if __name__ == "__main__":
    main()
