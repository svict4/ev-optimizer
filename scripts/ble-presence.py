#!/usr/bin/env python3
"""Bluetooth car-presence reporter for the ev-optimiser Worker.

Run on any always-on Linux box near where the car parks (Raspberry Pi etc.)
with a Bluetooth adapter:

    pip install bleak
    WORKER_URL=https://ev-optimiser.<you>.workers.dev \
    PRESENCE_KEY=... TESLA_VIN=5YJ... python3 ble-presence.py

Teslas advertise over BLE (for phone-key) even when asleep, with a local
name derived from the VIN: "S" + first 8 bytes of SHA-1(VIN) in hex + "C"
(the scheme in Tesla's vehicle-command library). This scans for that name
and POSTs /presence every INTERVAL_S seconds. A missed scan is common, so
"away" is only reported after MISSES_BEFORE_AWAY consecutive misses; the
Worker itself treats a report older than 15 min as away, so a dead scanner
fails safe (no car commands).
"""
import asyncio
import hashlib
import json
import os
import sys
import urllib.request

from bleak import BleakScanner

WORKER_URL = os.environ["WORKER_URL"].rstrip("/")
PRESENCE_KEY = os.environ["PRESENCE_KEY"]
VIN = os.environ["TESLA_VIN"].strip().upper()
INTERVAL_S = int(os.environ.get("INTERVAL_S", "60"))
SCAN_S = float(os.environ.get("SCAN_S", "10"))
MISSES_BEFORE_AWAY = int(os.environ.get("MISSES_BEFORE_AWAY", "3"))

LOCAL_NAME = "S" + hashlib.sha1(VIN.encode()).hexdigest()[:16] + "C"


def report(home: bool) -> None:
    req = urllib.request.Request(
        f"{WORKER_URL}/presence",
        data=json.dumps({"home": home, "source": "ble-presence.py"}).encode(),
        headers={"Authorization": f"Bearer {PRESENCE_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as res:
        res.read()


async def seen() -> bool:
    found = await BleakScanner.find_device_by_filter(
        lambda d, adv: (adv.local_name or d.name) == LOCAL_NAME, timeout=SCAN_S
    )
    return found is not None


async def main() -> None:
    print(f"watching for {LOCAL_NAME}", file=sys.stderr)
    misses = MISSES_BEFORE_AWAY  # start "away" until first sighting
    while True:
        try:
            misses = 0 if await seen() else misses + 1
        except Exception as e:  # adapter hiccup: count as a miss, keep going
            print(f"scan failed: {e}", file=sys.stderr)
            misses += 1
        home = misses < MISSES_BEFORE_AWAY
        try:
            report(home)
        except Exception as e:  # Worker unreachable: its staleness check covers us
            print(f"report failed: {e}", file=sys.stderr)
        await asyncio.sleep(max(0, INTERVAL_S - SCAN_S))


if __name__ == "__main__":
    asyncio.run(main())
