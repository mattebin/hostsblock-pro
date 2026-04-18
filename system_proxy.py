"""
Windows system proxy registry management.

Sets / unsets the per-user WinINET proxy at
``HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings`` and
tells WinINET to pick up the change immediately via ``InternetSetOption``.

Previous values are saved so they can be restored when the user toggles OFF.
"""

from __future__ import annotations

import ctypes
import json
import logging
from ctypes import wintypes
from pathlib import Path

import winreg

log = logging.getLogger("interceptify")

REG_PATH = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings"
ENV_REG_PATH = r"Environment"  # HKCU\Environment — persistent user env vars

# WinINET option codes — signal other processes that proxy settings changed
INTERNET_OPTION_SETTINGS_CHANGED = 39
INTERNET_OPTION_REFRESH = 37

DEFAULT_PROXY = "127.0.0.1:8080"
DEFAULT_OVERRIDE = "<local>;localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;*.local"


# ---------------------------------------------------------------------------
# Low-level registry helpers
# ---------------------------------------------------------------------------

def _read(name: str):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_PATH, 0, winreg.KEY_READ) as k:
            val, _ = winreg.QueryValueEx(k, name)
            return val
    except FileNotFoundError:
        return None


def _write(name: str, value, value_type=winreg.REG_SZ) -> None:
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_PATH, 0, winreg.KEY_SET_VALUE) as k:
        winreg.SetValueEx(k, name, 0, value_type, value)


def _delete(name: str) -> None:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_PATH, 0, winreg.KEY_SET_VALUE) as k:
            winreg.DeleteValue(k, name)
    except FileNotFoundError:
        pass


def _env_read(name: str):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, ENV_REG_PATH, 0, winreg.KEY_READ) as k:
            val, _ = winreg.QueryValueEx(k, name)
            return val
    except FileNotFoundError:
        return None


def _env_write(name: str, value: str) -> None:
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, ENV_REG_PATH, 0, winreg.KEY_SET_VALUE) as k:
        winreg.SetValueEx(k, name, 0, winreg.REG_SZ, value)


def _env_delete(name: str) -> None:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, ENV_REG_PATH, 0, winreg.KEY_SET_VALUE) as k:
            winreg.DeleteValue(k, name)
    except FileNotFoundError:
        pass


def _broadcast_env_change() -> None:
    """Tell running processes (Explorer, shells) to refresh env vars."""
    try:
        HWND_BROADCAST = 0xFFFF
        WM_SETTINGCHANGE = 0x001A
        SMTO_ABORTIFHUNG = 0x0002
        result = ctypes.c_ulong()
        ctypes.windll.user32.SendMessageTimeoutW(
            HWND_BROADCAST, WM_SETTINGCHANGE, 0,
            ctypes.c_wchar_p("Environment"),
            SMTO_ABORTIFHUNG, 5000, ctypes.byref(result)
        )
    except Exception as e:
        log.warning("Env broadcast failed: %s", e)


def _bypass_to_no_proxy(hosts: list[str]) -> str:
    """
    Convert bypass.txt entries to an NO_PROXY-formatted string.

    Python's ``requests``/``httpx`` (and most HTTP libs) read NO_PROXY and
    treat each entry as a suffix match — e.g. ``openai.com`` matches
    ``api.openai.com``. We strip any leading ``*.`` since that's not portable.
    """
    out = []
    for h in hosts:
        h = h.strip().lower()
        if h.startswith("*."):
            h = h[2:]
        if h:
            out.append(h)
    return ",".join(out)


def _notify_wininet() -> None:
    """Tell WinINET (and browsers/apps using it) that proxy settings changed."""
    try:
        internet_set_option = ctypes.windll.Wininet.InternetSetOptionW
        internet_set_option.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD]
        internet_set_option.restype = wintypes.BOOL
        internet_set_option(0, INTERNET_OPTION_SETTINGS_CHANGED, 0, 0)
        internet_set_option(0, INTERNET_OPTION_REFRESH, 0, 0)
    except Exception as e:
        log.warning("InternetSetOption refresh failed: %s", e)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def snapshot_current() -> dict:
    """Capture current proxy-related registry values so we can restore them."""
    return {
        "ProxyEnable": _read("ProxyEnable"),
        "ProxyServer": _read("ProxyServer"),
        "ProxyOverride": _read("ProxyOverride"),
        "NO_PROXY": _env_read("NO_PROXY"),
    }


def save_snapshot(path: Path, snap: dict) -> None:
    path.write_text(json.dumps(snap, indent=2, default=str), encoding="utf-8")


def load_snapshot(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def enable(
    server: str = DEFAULT_PROXY,
    override: str = DEFAULT_OVERRIDE,
    bypass_hosts: list[str] | None = None,
) -> None:
    """
    Turn the system proxy ON, pointing at ``server``.

    ``bypass_hosts`` is appended to the default LAN override list so traffic
    to those hosts skips the proxy entirely. Use it for endpoints with
    certificate pinning or their own CA bundle (Anthropic, OpenAI, etc.).
    """
    full_override = override
    if bypass_hosts:
        cleaned = ";".join(h.strip() for h in bypass_hosts if h.strip())
        if cleaned:
            full_override = full_override + ";" + cleaned
    _write("ProxyEnable", 1, winreg.REG_DWORD)
    _write("ProxyServer", server)
    _write("ProxyOverride", full_override)
    _notify_wininet()

    # Also set the NO_PROXY user env var so Python / Node / Go / cURL-based
    # clients (which ignore WinINET's ProxyOverride) bypass these hosts too.
    if bypass_hosts:
        np = _bypass_to_no_proxy(bypass_hosts)
        if np:
            _env_write("NO_PROXY", np)
            _broadcast_env_change()
            log.info("NO_PROXY set for %d host(s)", len(bypass_hosts))


def load_bypass_file(path: Path) -> list[str]:
    """Read a bypass.txt file: one host per line, # comments, blanks ignored."""
    if not path.exists():
        return []
    out: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s and not s.startswith("#"):
            out.append(s)
    return out


def disable() -> None:
    """Turn the system proxy OFF (leaves ProxyServer string in place but disabled)."""
    _write("ProxyEnable", 0, winreg.REG_DWORD)
    _notify_wininet()


def restore(snap: dict) -> None:
    """Restore a snapshot taken by ``snapshot_current()``."""
    if snap.get("ProxyEnable") is None:
        _delete("ProxyEnable")
    else:
        _write("ProxyEnable", int(snap["ProxyEnable"]), winreg.REG_DWORD)

    for key in ("ProxyServer", "ProxyOverride"):
        val = snap.get(key)
        if val is None:
            _delete(key)
        else:
            _write(key, val)

    _notify_wininet()

    # Restore (or clear) the NO_PROXY user env var we may have set.
    np = snap.get("NO_PROXY")
    if np is None:
        _env_delete("NO_PROXY")
    else:
        _env_write("NO_PROXY", np)
    _broadcast_env_change()
