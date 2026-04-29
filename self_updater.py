"""
Self-update for Interceptify.

Polls https://api.github.com/repos/mattebin/interceptify/releases/latest
and compares the latest release tag to the running version. If newer, the
tray exposes an "Install update" menu item that downloads the new exe and
swaps it in via a tiny batch helper (the running process can't overwrite
its own .exe on Windows).
"""

from __future__ import annotations

import json
import logging
import re
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

log = logging.getLogger("interceptify")

REPO = "mattebin/interceptify"
LATEST_URL = f"https://api.github.com/repos/{REPO}/releases/latest"
USER_AGENT = "Interceptify-updater"


@dataclass
class Release:
    tag: str
    name: str
    html_url: str
    body: str
    exe_asset_url: Optional[str]
    exe_asset_size: int


def parse_version(s: str) -> tuple[int, ...]:
    """v1.4.0 -> (1, 4, 0). Unparseable -> (0,) so it always loses comparisons."""
    if not s:
        return (0,)
    m = re.match(r"v?(\d+(?:\.\d+)*)", s.strip())
    if not m:
        return (0,)
    return tuple(int(x) for x in m.group(1).split("."))


def get_latest_release() -> Optional[Release]:
    try:
        req = urllib.request.Request(LATEST_URL, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=8) as r:
            data = json.loads(r.read())
    except Exception as e:
        log.warning("Update check failed: %s", e)
        return None

    exe_url, exe_size = None, 0
    for a in data.get("assets", []):
        if a.get("name", "").lower() == "interceptify.exe":
            exe_url = a.get("browser_download_url")
            exe_size = int(a.get("size", 0))
            break

    return Release(
        tag=data.get("tag_name", ""),
        name=data.get("name", ""),
        html_url=data.get("html_url", ""),
        body=data.get("body", ""),
        exe_asset_url=exe_url,
        exe_asset_size=exe_size,
    )


def is_newer(latest_tag: str, current_version: str) -> bool:
    return parse_version(latest_tag) > parse_version(current_version)


def download_asset(url: str, dest: Path, timeout: int = 180) -> None:
    """Stream-download a release asset to ``dest``. Raises on failure."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(req, timeout=timeout) as r, tmp.open("wb") as f:
        while True:
            chunk = r.read(64 * 1024)
            if not chunk:
                break
            f.write(chunk)
    tmp.replace(dest)


def write_updater_bat(bat_path: Path, current_pid: int, new_exe: Path,
                      target_exe: Path) -> None:
    """
    Write a small batch script that:
      1. Waits for the running Interceptify PID to exit (so the exe unlocks)
      2. Moves the new exe over the current one
      3. Relaunches Interceptify
      4. Deletes itself
    """
    script = f"""@echo off
setlocal
set PID={current_pid}
:waitloop
tasklist /FI "PID eq %PID%" 2>NUL | findstr %PID% >NUL
if not errorlevel 1 (
    ping -n 2 127.0.0.1 >NUL
    goto waitloop
)
move /Y "{new_exe}" "{target_exe}" >NUL 2>&1
if errorlevel 1 (
    echo Failed to replace exe -- new build left at "{new_exe}"
    pause
    exit /b 1
)
start "" "{target_exe}"
del "%~f0"
"""
    bat_path.write_text(script, encoding="utf-8")
