# Interceptify

A small Windows tray app that **blocks ads in the Spotify desktop client** by patching its UI bundle (`xpui.spa`). Detection runs inside Spotify itself: the moment an ad is queued, the patch clicks skip-forward, and if Spotify denies the skip, it mutes via Spotify's own volume control.

> 🛑 **You need the desktop installer Spotify**, not the Microsoft Store version
> Download from **[spotify.com/download](https://www.spotify.com/download)**. The Store version is sandboxed and the patcher can't touch it.

> ⚠️ **Honest limitations.** Read these before installing.
> - Spotify auto-updates wipe the patch. Re-patch with one click after each update.
> - Detection relies on Spotify's DOM test-ids (`leavebehind-advertiser`, `embedded-ad`, …). When Spotify renames them in a future build, ads may slip through until selectors are updated. Issues / PRs welcome.
> - This is a hobby tool. If you want a maintained option for the full ecosystem, [Spicetify](https://spicetify.app/) is the bigger project.

## Install

### Easy — prebuilt .exe
1. Grab **Interceptify.exe** from the [Releases page](https://github.com/mattebin/interceptify/releases).
2. Double-click. Accept the UAC prompt (needed to write to `%APPDATA%\Spotify\Apps\xpui.spa`).
3. Right-click the tray shield → **Patch Spotify (start blocking ads)**.

### From source
```bat
pip install -r requirements.txt
python main.py
```
The app auto-elevates via UAC.

## Tray menu

| Item | What it does |
|---|---|
| **Patch Spotify** / **Unpatch Spotify** | Injects (or removes) the ad-block JS in `xpui.spa`. Closes & relaunches Spotify. |
| **Install update vX.Y.Z** | Appears when a newer release is on GitHub. Auto-downloads + restarts. |
| **Show status dot in Spotify** | Toggles the small dot in Spotify's top-right that shows ad-block state (green = idle, red = ad detected). |
| **Run at Windows startup** | Adds Interceptify to your `HKCU\…\Run` so it's always there to re-patch after Spotify updates. |
| **Exit** | Quits the tray (the patch stays applied). |

## How it works

1. **Patch on disk.** `spotify_patcher.py` opens `%APPDATA%\Spotify\Apps\xpui.spa` (a ZIP), backs up the pristine version once to `xpui.spa.interceptify-backup`, injects an inline `<script>` tag into `index.html`, and re-zips. The script is `extensions/adblock.js`.

2. **Detection inside Spotify.** When you launch Spotify, our JS runs. It:
   - Polls the DOM every 500 ms for ad-related test-ids (the `leavebehind-*` family, `embedded-ad`, `ads-video-player-npv`, `canvas-ad-player`, etc.)
   - Hooks any object's `.on()` / `.emit()` looking for Spotify's own `'adplaying'` / `'adbreakstart'` events
   - Checks for elements whose class or text says "Advertisement"
   - Falls back to a heuristic: short audio + bare "Spotify" document title

3. **Action when an ad fires.**
   - Click `[data-testid="control-button-skip-forward"]` — works pre-audio
   - If skip denied, click `[data-testid="volume-bar-toggle-mute-button"]` — silences the ad. State-tracked so we don't override your manual mute.
   - Visual ad slots (`home-ad-card`, `embedded-ad-carousel`, …) are hidden via injected CSS.

## Detective / debug

Spotify recent builds removed Ctrl+Shift+I, gating DevTools behind a server-side employee flag. Interceptify launches Spotify with `--remote-debugging-port=9222 --remote-allow-origins=*` so you can attach DevTools from any Chromium browser:

```
http://127.0.0.1:9222
```

In the DevTools console you have:
```js
__interceptify.status()    // detection counters
__interceptify.scanAds()   // ad-shaped elements right now
__interceptify.testIds()   // every data-testid in the DOM
```

## Building yourself

```bat
pip install -r requirements.txt pyinstaller
pyinstaller --noconfirm --onefile --windowed ^
  --name "Interceptify" ^
  --manifest interceptify.manifest ^
  --uac-admin ^
  --add-data "extensions;extensions" ^
  main.py
```

Output: `dist\Interceptify.exe`

## License

MIT — see [LICENSE](LICENSE).

## Notes

Earlier Interceptify releases (≤ v1.4.0) shipped a mitmproxy + Windows-system-proxy pipeline that filtered ad URLs at the network level. Spotify 1.2.88+ stopped using the Windows proxy for its API and audio traffic, so that pipeline no longer affects Spotify and was removed in v1.5.0. The xpui patch is the only working layer on modern Spotify.
