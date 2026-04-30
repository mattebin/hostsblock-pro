"""
Interceptify - Windows tray app that patches Spotify's xpui.spa to detect
ad tracks in the desktop client and skip / mute them.

Why xpui-only and not the old mitmproxy pipeline:
    Spotify 1.2.88+ stopped using the Windows system proxy. All API and
    audio traffic now goes direct (TCP + QUIC), so mitmproxy can't see it.
    The client-side patch is the only working layer on modern Spotify.

What the patch does (extensions/adblock.js, inlined into Spotify's index.html):
    - Watches the DOM for ad-test-ids (leavebehind-*, ads-video-player-npv,
      embedded-ad, etc.) and Spotify's own 'adplaying'/'adbreakstart' events
    - When an ad is detected: clicks Spotify's skip-forward, then if skip
      is denied, clicks Spotify's volume-mute button. State-tracked so we
      don't override the user's manual mute.
    - Hides visual ad surfaces (home-ad-card, embedded-ad-carousel, ...)
      via CSS rules.

The tray app's runtime job is small: own the patch lifecycle, monitor
Spotify auto-updates and re-apply the patch when it gets wiped, and
self-update from GitHub releases.
"""

from __future__ import annotations

import atexit
import ctypes
import json
import logging
import os
import subprocess
import sys
import threading
import time
from ctypes import wintypes
from pathlib import Path
from typing import Optional

from PIL import Image, ImageDraw
import pystray
from pystray import MenuItem as Item, Menu

import self_updater
import spotify_patcher

# Optional personal modules - present in some local installs only. Public
# builds never ship these; importing optionally keeps main.py portable.
try:
    import update_watcher  # type: ignore
    HAS_UPDATE_WATCHER = True
except ImportError:
    update_watcher = None  # type: ignore
    HAS_UPDATE_WATCHER = False


APP_NAME = "Interceptify"
APP_VERSION = "1.5.2"  # bump in lockstep with the GitHub tag

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("interceptify")


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

def app_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent


def bundled_root() -> Path:
    """Where PyInstaller-bundled data lives at runtime (sys._MEIPASS one-file)."""
    return Path(getattr(sys, "_MEIPASS", str(app_root())))


def ensure_bundled_default(name: str) -> None:
    target = ROOT / name
    if target.exists():
        return
    src = bundled_root() / name
    if not src.exists() or src == target:
        return
    try:
        if src.is_dir():
            import shutil
            shutil.copytree(src, target)
        else:
            target.write_bytes(src.read_bytes())
        log.info("Seeded %s from bundle", name)
    except Exception as e:
        log.warning("Could not seed %s: %s", name, e)


ROOT = app_root()
CONFIG_PATH = ROOT / "config.json"

# First-run: copy editable defaults out of the PyInstaller bundle
ensure_bundled_default("extensions")


# ---------------------------------------------------------------------------
# Elevation
# ---------------------------------------------------------------------------

def is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def relaunch_as_admin() -> None:
    rc = ctypes.windll.shell32.ShellExecuteW(
        None, "runas", sys.executable, f'"{sys.argv[0]}"', None, 1
    )
    if rc <= 32:
        ctypes.windll.user32.MessageBoxW(
            None,
            f"{APP_NAME} requires Administrator privileges to write Spotify's xpui.spa.",
            APP_NAME,
            0x10,
        )
    sys.exit(0)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DEFAULT_CONFIG = {
    "show_badge": True,
}


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except Exception:
            pass
    try:
        CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    except Exception:
        pass
    return cfg


def save_config(cfg: dict) -> None:
    try:
        CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    except Exception as e:
        log.warning("save_config failed: %s", e)


# ---------------------------------------------------------------------------
# Icon
# ---------------------------------------------------------------------------

def make_icon(active: bool) -> Image.Image:
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    fill = (46, 160, 67, 255) if active else (120, 120, 120, 255)
    border = (20, 90, 40, 255) if active else (60, 60, 60, 255)
    d.rounded_rectangle((6, 6, size - 6, size - 6), radius=14, fill=fill, outline=border, width=3)
    if active:
        d.line((18, 34, 28, 44), fill="white", width=6)
        d.line((28, 44, 48, 22), fill="white", width=6)
    else:
        d.line((18, 18, 46, 46), fill="white", width=6)
        d.line((46, 18, 18, 46), fill="white", width=6)
    return img


# ---------------------------------------------------------------------------
# Tray application
# ---------------------------------------------------------------------------

class InterceptifyApp:
    def __init__(self) -> None:
        self.cfg = load_config()
        self.icon: Optional[pystray.Icon] = None
        self._latest_release: Optional[self_updater.Release] = None

        # Optional personal feature: Spotify-update watcher + ntfy push.
        # Activates only if the local update_watcher.py is present.
        self._spotify_watcher = None
        if HAS_UPDATE_WATCHER:
            try:
                self._spotify_watcher = update_watcher.UpdateWatcher(
                    xpui_path=spotify_patcher.spotify_xpui_path(),
                    is_patched_fn=spotify_patcher.is_patched,
                    on_update=self._on_spotify_update,
                    poll_sec=int(self.cfg.get("watcher_poll_sec", 300)),
                )
            except Exception as e:
                log.warning("update_watcher init failed: %s", e)

        atexit.register(self._on_exit)

    # ---- Helpers ---------------------------------------------------------

    def notify(self, msg: str, title: str = APP_NAME) -> None:
        log.info("NOTIFY: %s", msg)
        try:
            if self.icon is not None:
                self.icon.notify(msg, title)
        except Exception as e:
            log.warning("Notify failed: %s -- %s", e, msg)

    def _push_multi(self, title: str, message: str, tags=None) -> None:
        """Toast on Windows + optional ntfy.sh push (only if update_watcher present)."""
        self.notify(message, title=title)
        if not HAS_UPDATE_WATCHER:
            return
        topic = (self.cfg.get("ntfy_topic") or "").strip()
        if topic:
            try:
                update_watcher.send_ntfy(topic, message, title=title, tags=tags or [])
            except Exception as e:
                log.warning("ntfy push failed: %s", e)

    def _is_active(self) -> bool:
        """Active = Spotify is currently patched."""
        try:
            return spotify_patcher.is_patched()
        except Exception:
            return False

    def refresh_icon(self) -> None:
        if self.icon is None:
            return
        active = self._is_active()
        self.icon.icon = make_icon(active)
        if active:
            state = "blocking Spotify ads"
        elif spotify_patcher.is_installed():
            state = "idle - Spotify not patched"
        else:
            state = "Spotify not installed"
        title = f"{APP_NAME}: {state}"
        if self._latest_release is not None:
            title += f"  -  Update {self._latest_release.tag} available"
        self.icon.title = title[:127]
        try:
            self.icon.menu = self.build_menu()
        except Exception:
            pass

    # ---- Patch lifecycle ------------------------------------------------

    def _current_show_badge(self) -> bool:
        return bool(self.cfg.get("show_badge", True))

    def patch_spotify(self, *_args) -> None:
        def worker():
            if not spotify_patcher.is_installed():
                self.notify("Spotify not found. Install from spotify.com (desktop, not Store).")
                return
            if spotify_patcher.is_spotify_running():
                self.notify("Closing Spotify to apply patch...")
                spotify_patcher.kill_spotify()
                time.sleep(2)
            ok, msg = spotify_patcher.patch(show_badge=self._current_show_badge())
            log.info("patch_spotify: ok=%s msg=%s", ok, msg)
            self.notify(msg)
            if ok:
                spotify_patcher.launch_spotify()
            self.refresh_icon()
        threading.Thread(target=worker, daemon=True).start()

    def unpatch_spotify(self, *_args) -> None:
        def worker():
            if spotify_patcher.is_spotify_running():
                self.notify("Closing Spotify to restore original...")
                spotify_patcher.kill_spotify()
                time.sleep(2)
            ok, msg = spotify_patcher.unpatch()
            log.info("unpatch_spotify: ok=%s msg=%s", ok, msg)
            self.notify(msg)
            if ok:
                spotify_patcher.launch_spotify()
            self.refresh_icon()
        threading.Thread(target=worker, daemon=True).start()

    def toggle(self, *_args) -> None:
        if self._is_active():
            self.unpatch_spotify()
        else:
            self.patch_spotify()

    def toggle_show_badge(self, *_args) -> None:
        def worker():
            new_val = not self._current_show_badge()
            self.cfg["show_badge"] = new_val
            save_config(self.cfg)
            if not spotify_patcher.is_installed() or not spotify_patcher.is_patched():
                self.notify(f"Status dot {'shown' if new_val else 'hidden'} (re-patch to apply).")
                return
            was_running = spotify_patcher.is_spotify_running()
            if was_running:
                spotify_patcher.kill_spotify()
                time.sleep(2)
            ok, msg = spotify_patcher.patch(show_badge=new_val)
            if ok:
                spotify_patcher.launch_spotify()
                self.notify(f"Status dot {'shown' if new_val else 'hidden'}. Spotify relaunched.")
            else:
                self.notify(msg)
        threading.Thread(target=worker, daemon=True).start()

    # ---- Self-update -----------------------------------------------------

    def _poll_for_updates_loop(self) -> None:
        first = True
        while True:
            time.sleep(60 if first else 6 * 3600)
            first = False
            try:
                rel = self_updater.get_latest_release()
                if rel and self_updater.is_newer(rel.tag, APP_VERSION):
                    if self._latest_release is None or self._latest_release.tag != rel.tag:
                        log.info("Update available: %s (current %s)", rel.tag, APP_VERSION)
                        self._latest_release = rel
                        self.refresh_icon()
                        self.notify(
                            f"Update {rel.tag} available. Click 'Install update' in the tray menu.",
                        )
                else:
                    if self._latest_release is not None:
                        self._latest_release = None
                        self.refresh_icon()
            except Exception as e:
                log.warning("Update poll failed: %s", e)

    def install_update(self, *_args) -> None:
        rel = self._latest_release
        if rel is None:
            self.notify("No update pending.")
            return
        msg = (
            f"Interceptify {rel.tag} is available.\n\n"
            f"Current version: {APP_VERSION}\n"
            f"Download size:   {rel.exe_asset_size // (1024*1024)} MB\n\n"
            "The app will close, replace itself, and relaunch automatically.\n\n"
            "Install now?"
        )
        try:
            answer = ctypes.windll.user32.MessageBoxW(
                None, msg, f"{APP_NAME} update", 0x4 | 0x20 | 0x40000
            )
        except Exception as e:
            log.warning("MessageBox failed: %s", e)
            answer = 6
        if answer != 6:
            return
        threading.Thread(target=self._perform_update, args=(rel,), daemon=True).start()

    def _perform_update(self, rel: "self_updater.Release") -> None:
        if not getattr(sys, "frozen", False):
            try:
                ctypes.windll.user32.MessageBoxW(
                    None,
                    "You're running Interceptify from source.\n"
                    f"Update with: git pull && pip install -r requirements.txt\n"
                    f"\nLatest release: {rel.html_url}",
                    f"{APP_NAME} update",
                    0x40 | 0x40000,
                )
            except Exception:
                self.notify("Source mode: git pull to update.")
            return
        if not rel.exe_asset_url:
            self.notify(f"Latest release {rel.tag} has no Interceptify.exe asset.")
            return
        self.notify(f"Downloading {rel.tag}...")
        new_exe = ROOT / "Interceptify.exe.new"
        try:
            self_updater.download_asset(rel.exe_asset_url, new_exe)
        except Exception as e:
            self.notify(f"Download failed: {e}")
            return
        target_exe = Path(sys.executable).resolve()
        bat = ROOT / "_interceptify_update.bat"
        try:
            self_updater.write_updater_bat(
                bat, current_pid=os.getpid(),
                new_exe=new_exe.resolve(), target_exe=target_exe,
            )
        except Exception as e:
            self.notify(f"Updater script failed: {e}")
            return
        self.notify(f"Installing {rel.tag} - the app will restart in a few seconds.")
        try:
            subprocess.Popen(
                ["cmd", "/c", str(bat)],
                creationflags=0x00000008 | 0x00000200,
                close_fds=True,
            )
        except Exception as e:
            self.notify(f"Updater launch failed: {e}")
            return
        try:
            self.icon.stop()
        except Exception:
            pass
        os._exit(0)

    # ---- Personal: Spotify-update watcher (optional) -------------------

    def _on_spotify_update(self, event: dict) -> None:
        """Called by update_watcher when xpui.spa changes on disk (personal feature)."""
        if not event.get("wiped"):
            return
        auto = bool(self.cfg.get("auto_repatch_spotify", False))
        if auto:
            was_running = spotify_patcher.is_spotify_running()
            if was_running:
                spotify_patcher.kill_spotify()
                time.sleep(2)
            ok, _msg = spotify_patcher.patch(show_badge=self._current_show_badge())
            if ok and was_running:
                spotify_patcher.launch_spotify()
            self._push_multi(
                "Spotify updated - patch re-applied",
                f"Spotify auto-updated and wiped Interceptify's patch. "
                f"Auto-repatch {'succeeded' if ok else 'FAILED'}.",
                tags=["white_check_mark" if ok else "rotating_light"],
            )
        else:
            self._push_multi(
                "Spotify updated - ad-block wiped",
                "Spotify auto-updated and removed Interceptify's patch. "
                "Right-click the tray icon -> Patch Spotify to re-apply.",
                tags=["warning"],
            )
        self.refresh_icon()

    def toggle_auto_repatch(self, *_args) -> None:
        new_val = not bool(self.cfg.get("auto_repatch_spotify", False))
        self.cfg["auto_repatch_spotify"] = new_val
        save_config(self.cfg)
        self.notify(f"Auto re-patch after Spotify updates: {'ON' if new_val else 'OFF'}")

    def test_ntfy(self, *_args) -> None:
        def worker():
            try:
                fresh = load_config()
                self.cfg.update(fresh)
                topic = (self.cfg.get("ntfy_topic") or "").strip()
                if not topic:
                    self.notify("No ntfy_topic set in config.json.")
                    return
                ok = update_watcher.send_ntfy(
                    topic, "Test push from Interceptify tray.",
                    title="Interceptify test", tags=["test_tube"],
                )
                self.notify(f"ntfy.sh test {'sent' if ok else 'FAILED'} to {topic}")
            except Exception as e:
                self.notify(f"test_ntfy error: {e}")
        threading.Thread(target=worker, daemon=True).start()

    # ---- Run at Windows startup ----------------------------------------

    _RUN_REG_PATH = r"Software\Microsoft\Windows\CurrentVersion\Run"
    _RUN_VALUE_NAME = "Interceptify"

    def _autostart_command(self) -> str:
        if getattr(sys, "frozen", False):
            return f'"{sys.executable}"'
        py = sys.executable
        if py.lower().endswith("python.exe"):
            pyw = py[:-10] + "pythonw.exe"
            if Path(pyw).exists():
                py = pyw
        return f'"{py}" "{Path(__file__).resolve()}"'

    def _is_autostart_enabled(self) -> bool:
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, self._RUN_REG_PATH, 0, winreg.KEY_READ) as k:
                val, _ = winreg.QueryValueEx(k, self._RUN_VALUE_NAME)
                return bool(val)
        except (FileNotFoundError, OSError):
            return False

    def toggle_autostart(self, *_args) -> None:
        import winreg
        currently_on = self._is_autostart_enabled()
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, self._RUN_REG_PATH, 0,
                                winreg.KEY_SET_VALUE) as k:
                if currently_on:
                    try:
                        winreg.DeleteValue(k, self._RUN_VALUE_NAME)
                    except FileNotFoundError:
                        pass
                    self.notify("Auto-start at Windows login: OFF")
                else:
                    winreg.SetValueEx(k, self._RUN_VALUE_NAME, 0, winreg.REG_SZ,
                                      self._autostart_command())
                    self.notify("Auto-start at Windows login: ON")
        except Exception as e:
            self.notify(f"Auto-start toggle failed: {e}")
        self.refresh_icon()

    # ---- Exit ----------------------------------------------------------

    def quit_app(self, *_args) -> None:
        if self.icon is not None:
            self.icon.stop()

    def _on_exit(self) -> None:
        # Stop the optional Spotify-update watcher cleanly
        if self._spotify_watcher is not None:
            try:
                self._spotify_watcher.stop()
            except Exception:
                pass

    # ---- Menu ----------------------------------------------------------

    def build_menu(self) -> Menu:
        active = self._is_active()
        toggle_label = (
            "Unpatch Spotify (stop blocking ads)"
            if active else
            "Patch Spotify (start blocking ads)"
        )
        update_label = (
            f"Install update {self._latest_release.tag}"
            if self._latest_release else
            "Install update"
        )
        items = [
            Item(toggle_label, self.toggle, default=True),
            Item(
                update_label, self.install_update,
                visible=lambda item: self._latest_release is not None,
            ),
            Menu.SEPARATOR,
            Item(
                "Show status dot in Spotify",
                self.toggle_show_badge,
                checked=lambda item: self._current_show_badge(),
            ),
        ]
        if HAS_UPDATE_WATCHER:
            items.append(Item(
                "Auto re-patch after Spotify updates",
                self.toggle_auto_repatch,
                checked=lambda item: bool(self.cfg.get("auto_repatch_spotify", False)),
            ))
            items.append(Item("Send test phone notification (ntfy.sh)", self.test_ntfy))
        items.extend([
            Menu.SEPARATOR,
            Item(
                "Run at Windows startup",
                self.toggle_autostart,
                checked=lambda item: self._is_autostart_enabled(),
            ),
            Menu.SEPARATOR,
            Item("Exit", self.quit_app),
        ])
        return Menu(*items)

    def run(self) -> None:
        active = self._is_active()
        self.icon = pystray.Icon(
            APP_NAME,
            icon=make_icon(active),
            title=f"{APP_NAME}: starting...",
            menu=self.build_menu(),
        )
        # Initial tooltip + start the self-update poll
        threading.Thread(target=self._poll_for_updates_loop, daemon=True).start()
        if self._spotify_watcher is not None:
            try:
                self._spotify_watcher.start()
            except Exception as e:
                log.warning("Could not start Spotify-update watcher: %s", e)
        # Refresh tooltip once icon exists
        threading.Thread(target=lambda: (time.sleep(0.5), self.refresh_icon()), daemon=True).start()
        self.icon.run()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    if not is_admin():
        relaunch_as_admin()
        return
    InterceptifyApp().run()


if __name__ == "__main__":
    main()
