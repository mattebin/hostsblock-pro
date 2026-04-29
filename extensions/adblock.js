/*
 * Interceptify ad-block — injected into Spotify's xpui.spa.
 *
 * Strategy, in order of preference:
 *   1. Hook window.fetch / XHR: stub out requests to known ad endpoints
 *      before they leave the app. (Belt + braces with Interceptify's proxy.)
 *   2. Watch Spotify's track state via the DOM; when the current track is
 *      flagged as an advertisement, seek to the end / press skip.
 *   3. Fallback: mute the <audio> element whenever an ad is detected so
 *      even un-skippable ones become silent.
 *
 * Why this file is small and simple: every update to Spotify's internal JS
 * can rename private symbols, so we stick to stable surfaces (DOM test-ids,
 * fetch URLs, <audio> elements). Easier to keep alive than reaching into
 * their redux store.
 */
(function () {
  const TAG = "[interceptify]";
  const log = (...a) => console.log(TAG, ...a);

  // Visible signal the script loaded — adds a small green dot to the top-right
  // corner of the Spotify window. No DevTools needed to confirm.
  // Set window.__INTERCEPTIFY_SHOW_BADGE = false (injected at patch time)
  // to suppress it.
  const SHOW_BADGE = window.__INTERCEPTIFY_SHOW_BADGE !== false;
  function mountBadge() {
    if (!SHOW_BADGE) return;
    if (document.getElementById("interceptify-badge")) return;
    const b = document.createElement("div");
    b.id = "interceptify-badge";
    b.title = "Interceptify ad-block active";
    b.style.cssText = [
      // Sit inside the top nav bar, just left of the "Upgrade to Premium"
      // button. Anchoring to the top-right and offsetting right:~270px keeps
      // it in the same visible spot as the Spotify window resizes.
      "position:fixed",
      "top:18px",
      "right:270px",
      "width:12px",
      "height:12px",
      "border-radius:50%",
      "background:#1ed760",
      "box-shadow:0 0 6px #1ed760",
      "z-index:2147483647",
      "cursor:help",
      "opacity:0.85",
    ].join(";");
    (document.body || document.documentElement).appendChild(b);
  }
  if (document.body) mountBadge();
  else document.addEventListener("DOMContentLoaded", mountBadge);
  // Spotify re-renders the root; re-mount if our badge vanishes.
  setInterval(mountBadge, 2000);

  // ------------------------------------------------------------------
  // 1. Network shim — neutralise ad endpoints client-side
  // ------------------------------------------------------------------
  const AD_URL_SIGNALS = [
    "/ads/",
    "/ad-logic/",
    "/gabo-receiver-service/",
    "/pagead",
    "doubleclick.net",
    "adeventtracker",
  ];

  function looksLikeAdUrl(url) {
    if (typeof url !== "string") {
      try { url = String(url); } catch { return false; }
    }
    return AD_URL_SIGNALS.some((s) => url.includes(s));
  }

  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : input && input.url;
      if (url && looksLikeAdUrl(url)) {
        log("blocked fetch:", url);
        try { setBadgeState("blocked"); setTimeout(() => setBadgeState(wasAd ? "ad" : "idle"), 800); } catch {}
        return Promise.resolve(
          new Response("{}", { status: 403, headers: { "Content-Type": "application/json" } })
        );
      }
    } catch {}
    return _fetch.apply(this, arguments);
  };

  const _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__interceptify_url = url;
    return _xhrOpen.apply(this, arguments);
  };
  const _xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    if (looksLikeAdUrl(this.__interceptify_url)) {
      log("blocked xhr:", this.__interceptify_url);
      // Simulate a dead request — fire error after a microtask
      setTimeout(() => this.dispatchEvent(new Event("error")), 0);
      return;
    }
    return _xhrSend.apply(this, arguments);
  };

  // ------------------------------------------------------------------
  // 2 + 3. Detect ad playback and skip / mute
  // ------------------------------------------------------------------

  // Updated 2026-04-29 from static analysis of Spotify 1.2.88.483 xpui.spa.
  // Strong (audio ad context, almost no false positives):
  const STRONG_AD_SELECTORS = [
    '[data-testid="context-item-info-ad-title"]',
    '[data-testid="ads-video-player-npv"]',
    '[data-testid="standalone-video-ad-player"]',
    '[data-testid="canvas-ad-player"]',
    '[data-testid="canvas-ad-container"]',
    '[data-testid="ad-controls"]',
    '[data-testid="ad-companion-card"]',
    '[data-testid="leavebehind-advertiser"]',
    '[data-testid="context-item-info"][aria-label*="Advertisement" i]',
    '[aria-label*="Advertisement" i][data-testid*="track"]',
  ];
  // Visual-only ad surfaces — we hide them via CSS rather than skip/mute
  const VISUAL_AD_SELECTORS = [
    '[data-testid="embedded-ad"]',
    '[data-testid="embedded-ad-carousel"]',
    '[data-testid="home-ad-card"]',
    '[data-testid="home-ads-container"]',
    '[data-testid="sponsored-recommendation-modal-trigger"]',
  ];

  // Hide visual-only ads with CSS so they never render.
  function injectAdHidingCSS() {
    if (document.getElementById("interceptify-hide-css")) return;
    const style = document.createElement("style");
    style.id = "interceptify-hide-css";
    style.textContent = VISUAL_AD_SELECTORS.map(s => s + " { display:none !important; }").join("\n");
    (document.head || document.documentElement).appendChild(style);
  }
  injectAdHidingCSS();
  setInterval(injectAdHidingCSS, 5000);

  // Hook Spotify's internal event-emitter pattern. The xpui code does things
  // like  n.on("adplaying", cb)  and  n.emit("adplaying"). We patch the
  // prototype methods most likely to be on the EventEmitter so that whenever
  // Spotify itself listens for ad events, we get notified too.
  let eventBasedAd = false;
  function tryHookEmitter(proto, methodName) {
    if (!proto || typeof proto[methodName] !== "function" || proto["__interceptify_" + methodName]) return;
    const orig = proto[methodName];
    proto["__interceptify_" + methodName] = true;
    proto[methodName] = function (eventName, handler, ...rest) {
      try {
        if (typeof eventName === "string") {
          if (/^ad(playing|breakstart)$/i.test(eventName)) {
            eventBasedAd = true;
            log("event-emitter ad signal:", eventName);
          } else if (/^ad(ended|breakend)$/i.test(eventName)) {
            eventBasedAd = false;
          }
        }
      } catch {}
      return orig.call(this, eventName, handler, ...rest);
    };
  }
  // We don't know the exact emitter class, so probe a few likely candidates
  // late (after Spotify has booted its module graph).
  setInterval(() => {
    try {
      tryHookEmitter(EventTarget && EventTarget.prototype, "dispatchEvent");
      // Walk a small set of globals looking for emitter-like objects
      for (const k of Object.keys(window)) {
        const v = window[k];
        if (v && typeof v === "object") {
          const proto = Object.getPrototypeOf(v);
          if (proto && typeof proto.emit === "function") tryHookEmitter(proto, "emit");
          if (proto && typeof proto.on === "function") tryHookEmitter(proto, "on");
        }
      }
    } catch {}
  }, 1500);

  function isAdPlaying() {
    // 1) Strong: data-testid match
    for (const s of STRONG_AD_SELECTORS) {
      if (document.querySelector(s)) return s;
    }
    // 2) Strong: event hook saw 'adplaying' / 'adbreakstart'
    if (eventBasedAd) return "event:adplaying";
    // 3) Strong: any element whose class or text declares Advertisement
    const all = document.querySelectorAll("[class*='Advertisement'], [class*='advertisement']");
    if (all.length) return "class:Advertisement";
    // 4) Now-playing title says Advertisement
    const titleEl = document.querySelector('[data-testid="context-item-link"]');
    if (titleEl && /advert/i.test(titleEl.textContent || "")) return "title-text:advert";
    // 5) <title> === "Spotify" with playing audio shorter than 60s -> very
    //    likely an ad. Music titles always include the track name.
    if (document.title.replace(/^●\s*/, "").trim() === "Spotify") {
      const a = document.querySelector("audio");
      if (a && isFinite(a.duration) && a.duration > 0 && a.duration < 65 && !a.paused) {
        return "heuristic:short-audio-no-title";
      }
    }
    return null;
  }

  function clickNextTrack() {
    const btn = document.querySelector('[data-testid="control-button-skip-forward"]');
    if (btn && !btn.disabled) { btn.click(); return true; }
    return false;
  }

  // During ads on Spotify Free 1.2.88+, the skip-forward button is REMOVED
  // entirely and replaced with podcast-style controls including
  // 'control-button-seek-forward-15' (jump 15s). That button is NOT disabled
  // during ads, and clicking it repeatedly drains the ad to its end --
  // Spotify then auto-advances. Verified live 2026-04-29.
  function spamSeekForward(times = 5) {
    const btn = document.querySelector('[data-testid="control-button-seek-forward-15"]');
    if (!btn) return false;
    for (let i = 0; i < times; i++) {
      try { btn.click(); } catch {}
    }
    return true;
  }

  // Spotify 1.2.88+ uses Web Audio API rather than an <audio> element, so
  // setting .muted on media elements is a no-op (there ARE no media elements
  // in the DOM). The reliable mute is to click Spotify's own volume-bar
  // mute button. We track whether _we_ muted so we don't un-mute the user's
  // own manual mute on ad-end.
  function _muteButton() {
    return document.querySelector('[data-testid="volume-bar-toggle-mute-button"]');
  }
  function _isCurrentlyMutedInUI() {
    // The button toggles an icon child; the most reliable way to tell the
    // state cross-locale is to look at aria-pressed, then fall back to icon
    // class names. Returns null if we can't tell.
    const btn = _muteButton();
    if (!btn) return null;
    const ap = btn.getAttribute("aria-pressed");
    if (ap === "true") return true;
    if (ap === "false") return false;
    // Heuristic: the muted-state icon's path tends to include "mute" or
    // a slashed-speaker SVG; otherwise volume-up/-down/-off.
    const svg = btn.querySelector("svg");
    if (svg) {
      const html = svg.outerHTML;
      if (/mute|VolumeOff/i.test(html)) return true;
    }
    return null;
  }
  let _weMuted = false;
  function muteAllAudio(shouldBeMuted) {
    // Best-effort no-op fallback for any media elements that DO exist
    // (rare in modern Spotify but cheap to keep).
    document.querySelectorAll("audio, video").forEach((el) => {
      el.muted = shouldBeMuted;
      if (shouldBeMuted) el.volume = 0;
    });
    const btn = _muteButton();
    if (!btn) return;
    const uiMuted = _isCurrentlyMutedInUI();
    if (shouldBeMuted) {
      // Mute only if not already muted
      if (uiMuted === false || (uiMuted === null && !_weMuted)) {
        btn.click();
        _weMuted = true;
      }
    } else {
      // Un-mute only if WE muted (don't fight the user's manual mute)
      if (_weMuted) {
        if (uiMuted !== false) btn.click();
        _weMuted = false;
      }
    }
  }

  function setBadgeState(state) {
    const b = document.getElementById("interceptify-badge");
    if (!b) return;
    const palette = {
      idle: "#1ed760",    // green — normal
      ad:   "#ff3b30",    // red — ad detected, blocking
      blocked: "#ffa500", // orange — network-level block just fired
    }[state] || "#1ed760";
    b.style.background = palette;
    b.style.boxShadow = `0 0 6px ${palette}`;
    b.title = "Interceptify: " + state;
  }

  let wasAd = null; // last-seen selector or null
  let stats = { detections: 0, lastDetection: null, lastSelector: null,
                fetchBlocked: 0, xhrBlocked: 0 };

  function check() {
    const detected = isAdPlaying();
    if (detected) {
      if (!wasAd) {
        stats.detections++;
        stats.lastDetection = new Date().toISOString();
        stats.lastSelector = detected;
        log("ad detected via:", detected);
        setBadgeState("ad");
        muteAllAudio(true);
      }
      // Keep applying skip on every iteration the ad is still present.
      // The standard skip button doesn't exist during Free ads, so we fall
      // back to spamming seek-forward-15 which DOES work and which Spotify
      // doesn't disable.
      if (!clickNextTrack()) {
        spamSeekForward(3);
      }
    } else if (!detected && wasAd) {
      log("ad ended");
      setBadgeState("idle");
      muteAllAudio(false);
    }
    wasAd = detected;
  }

  // Debug surface for DevTools. Open Spotify, Ctrl+Shift+I, type:
  //   __interceptify.status()       -> detection counts + last hit
  //   __interceptify.scanAds()      -> list any ad-shaped elements right now
  //   __interceptify.testIds()      -> all data-testid values currently in DOM
  window.__interceptify = {
    version: "2026-04-29",
    stats: () => ({ ...stats }),
    status() { console.table(stats); return stats; },
    scanAds() {
      const out = [];
      for (const s of STRONG_AD_SELECTORS.concat(VISUAL_AD_SELECTORS)) {
        const els = document.querySelectorAll(s);
        if (els.length) out.push({ selector: s, count: els.length });
      }
      console.table(out);
      return out;
    },
    testIds() {
      const ids = new Set();
      document.querySelectorAll("[data-testid]").forEach(e =>
        ids.add(e.getAttribute("data-testid")));
      const arr = [...ids].sort();
      console.log(`${arr.length} unique test-ids on page`);
      arr.forEach(t => { if (/ad|promo|sponsor/i.test(t)) console.log("  AD-ISH:", t); });
      return arr;
    },
  };

  // Poll every 500ms. Mutation observers are flakier across Spotify rebuilds
  // because the mounted component changes; a simple poll is more robust.
  setInterval(check, 500);
  log("loaded");
})();
