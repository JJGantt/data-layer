# TODO

- **Roomba on the Pi.** The Pi has been unreachable since 2026-11-22, so the Roomba is answered only by
  the Mac's home agent, and every request is reported as a fallback win. When the Pi is back: copy the
  three `ROOMBA_*` lines from the Mac's `data-layer/.env` into the Pi's (or run
  `python3 roomba/fetch-cloud.py 10.0.0.15` there), let `pull-repos` rebuild data-layer (it needs
  `npm install` for the new `mqtt` dependency), restart data-http, and check `roomba status` answers
  with no fallback error. Then delete this item.
