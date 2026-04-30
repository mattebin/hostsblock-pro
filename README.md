# Interceptify

A small Windows tray app that **blocks ads in the Spotify desktop client** by patching its UI bundle (`xpui.spa`). The current build blocks Spotify's in-stream ad payloads before they reach the visible player, suppresses the ad UI during the skip window, and keeps the older manifest/DOM fallback layers for extra coverage.

> 🛑 **You need the desktop installer Spotify**, not the Microsoft Store version
> Download from **[spotify.com/download](https://www.spotify.com/download)**. The Store version is sandboxed and the patcher can't touch it.

> ⚠️ **Honest limitations.**
> - Spotify auto-updates wipe the patch. Re-patch with one click after each update.
> - The in-stream payload block relies on Spotify's current `inStreamApi` shape. When Spotify changes that, ads may start coming through until the hook is updated.
> - The fallback manifest and DOM layers rely on endpoint fields and test-ids. Same caveat.
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

The patcher unzips Spotify's `xpui.spa`, injects an inline `<script>` of `extensions/adblock.js` into `index.html`, and re-zips. Original is preserved at `xpui.spa.interceptify-backup`. When Spotify launches, our script runs **before** Spotify's deferred `xpui-snapshot.js` — so we can hook fetch, WebSocket, MediaSource, etc. before the player code does anything.

### Layer 1 — In-stream payload block

The primary block hooks Spotify's renderer-side in-stream ad provider before the ad reaches the visible player:

| Signal | What we do |
|---|---|
| `inStreamApi.onAdMessageCallbacks` | Wrap callback listeners and swallow messages whose payload contains Spotify Ad Server metadata. |
| `inStreamApi.inStreamAd` | Clear ad objects as soon as Spotify writes them into the active in-stream state slot. |
| `getInStreamAd()` | Return `null` for ad objects and call `skipToNext()` once per ad payload. |
| Ad UI flash window | Temporarily suppress now-playing/ad widgets so an auto-skipped ad does not visibly flash. |

### Layer 2 — Manifest pre-player block

Fetch interceptors prevent known short ad manifests and their segments from loading:

| Endpoint | What we do |
|---|---|
| `/sponsoredplaylist/v1/sponsored` | Return `{"sponsorships":[]}`. Spotify has no sponsored playlists to inject. |
| `/manifests/v9/json/sources/<srcId>/options/...` | Inspect the response. If `end_time_millis < 60000` (= the manifest is for a clip < 60 seconds, i.e. an ad), **rewrite the response to `{"contents":[]}`** AND remember the `srcId`. |
| `/sources/<srcId>/...` segment fetches | If `srcId` is on our remembered ad-source list, return **404**. The ad's audio chunks never load. |

**Why it works:** Spotify identifies what to play via `/manifests/v9/json/sources/<id>/options/`. The response includes `end_time_millis`. Music is 200,000–500,000 ms (3–8 min). Ads are <60,000 ms (10–30 sec). That single field is the cleanest discriminator we found across hours of network capture.

### Layer 3 — In-player detection + skip (fallback)

If anything slips past Layer 1, this catches it:

- **Detection** (DOM polling every 500 ms + Spotify's own `'adplaying'`/`'adbreakstart'` events):
  `leavebehind-advertiser`, `embedded-ad`, `ads-video-player-npv`, `canvas-ad-player`, `ad-controls`, `ad-companion-card`, `video-takeover-link`, plus heuristics on `<title>` and short audio.
- **Action** (fires every 500 ms while an ad is detected):
  - Click `control-button-seek-forward-15` repeatedly (drains podcast-style ads in <1 s)
  - Click `control-button-skip-forward` (works for some ad types)
  - Set the progress slider `<input type="range">` to `max`
  - Pointer-click the far right of the progress bar
  - Fire `ArrowRight` / `Shift+ArrowRight` / `End` keyboard events
  - On `<video>` ads: set `playbackRate=16`, `currentTime=duration`, dispatch synthetic `'ended'`
  - Mute via Spotify's volume button (state-tracked so we don't fight your manual mute)
  - Call `endOfStream()` on every active `MediaSource`
  - Hide visual ad surfaces (`home-ad-card`, `embedded-ad-carousel`, …) via CSS

A `safeSkip` guard wraps `HTMLElement.click()` so our action loop can never click `skip-forward` on a real music track during the ad→music transition tick.

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

Plus — an in-page sniffer logs every fetch / XHR / WebSocket / MediaSource / sendBeacon event and tags them with whether an ad was active when fired. Useful for diagnosing new Spotify ad-delivery paths:
```js
window.__interceptify_sniffer        // ring buffer of all events
window.__interceptify_meta_log       // captured response bodies (manifests, metadata, pathfinder, sponsoredplaylist)
window.__interceptify_known_ad_sources  // set of srcIds classified as ad
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

v1.5.2 added the manifest-based pre-player block after a network capture revealed `end_time_millis` in the manifest response as a useful ad-vs-music discriminator.

v1.5.3 adds the in-stream payload block that wraps Spotify's renderer ad provider, swallows ad callback payloads, clears `inStreamAd`, and suppresses the brief ad UI flash during auto-skip.
