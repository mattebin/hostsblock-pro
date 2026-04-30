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

  // ===================================================================
  // EARLY HOOKS — must install before Spotify's deferred xpui-snapshot.js
  // runs, so we catch the dealer WebSocket and the very first fetches.
  // ===================================================================

  // Shared state
  window.__interceptify_ad_active = false;
  window.__interceptify_sniffer = window.__interceptify_sniffer || [];
  window.__interceptify_meta_log = window.__interceptify_meta_log || [];
  window.__interceptify_mediasources = window.__interceptify_mediasources || new Set();

  function snifferLog(kind, info) {
    try {
      window.__interceptify_sniffer.push({
        ts: Date.now(),
        adActive: !!window.__interceptify_ad_active,
        kind, ...info,
      });
      if (window.__interceptify_sniffer.length > 8000)
        window.__interceptify_sniffer = window.__interceptify_sniffer.slice(-4000);
    } catch {}
  }

  // ---- fetch hook (sniffer + ad-CDN blocker + metadata capture) ----
  if (window.fetch && !window.fetch.__interceptify_hooked) {
    const _f = window.fetch;
    window.fetch = function (input, init) {
      let url = "";
      try {
        url = typeof input === "string" ? input : (input && input.url) || "";
      } catch {}
      try {
        snifferLog("fetch", {
          url: url.slice(0, 220),
          method: (init && init.method) || (input && input.method) || "GET",
        });
      } catch {}

      // PRE-PLAYER BLOCK 1: starve Spotify of sponsored playlists.
      try {
        if (/\/sponsoredplaylist\/v\d+\/sponsored/.test(url)) {
          return Promise.resolve(new Response(
            JSON.stringify({ sponsorships: [] }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ));
        }
      } catch {}

      // PRE-PLAYER BLOCK 2: source-ID based segment block.
      // Every segment URL has a /sources/<srcId>/ component. Once a
      // manifest tells us a srcId is an ad (duration < 60s), 404 every
      // subsequent segment fetch with that srcId. Spotify's player can't
      // play what it can't fetch.
      try {
        const segMatch = url.match(/\/sources\/([a-f0-9]+)\//);
        if (segMatch && window.__interceptify_known_ad_sources &&
            window.__interceptify_known_ad_sources.has(segMatch[1])) {
          return Promise.resolve(new Response(new ArrayBuffer(0), {
            status: 404, statusText: "Blocked by Interceptify (known ad source)",
          }));
        }
      } catch {}

      // PRE-PLAYER BLOCK 3: manifest interception (THE source of truth).
      // Spotify fetches /manifests/v9/json/sources/<srcId>/options/... to
      // learn how to play a piece of media. The response includes
      // end_time_millis -- ad clips are < 60 sec, music/podcasts are
      // hundreds of seconds. If we see a short manifest, replace it with
      // an empty contents array AND remember the srcId so future segment
      // fetches for it get 404'd above.
      try {
        const mfMatch = url.match(/\/manifests\/v\d+\/json\/sources\/([a-f0-9]+)\/options/);
        if (mfMatch) {
          const srcId = mfMatch[1];
          window.__interceptify_known_ad_sources = window.__interceptify_known_ad_sources || new Set();
          // If we've already classified this srcId as ad, return empty immediately
          if (window.__interceptify_known_ad_sources.has(srcId)) {
            return Promise.resolve(new Response(
              JSON.stringify({ contents: [] }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            ));
          }
          // Otherwise fetch normally, then inspect & maybe rewrite
          return _f.apply(this, arguments).then(async (resp) => {
            try {
              const text = await resp.clone().text();
              const endMatches = text.match(/"end_time_millis"\s*:\s*(\d+)/g) || [];
              const maxEnd = endMatches
                .map((s) => parseInt(s.match(/(\d+)/)[1], 10))
                .reduce((a, b) => Math.max(a, b), 0);
              if (maxEnd > 0 && maxEnd < 60000) {
                window.__interceptify_known_ad_sources.add(srcId);
                console.log("[interceptify] ad manifest blocked: srcId=" + srcId.slice(0, 8) + "... duration=" + (maxEnd / 1000).toFixed(1) + "s");
                return new Response(
                  JSON.stringify({ contents: [] }),
                  { status: 200, headers: { "Content-Type": "application/json" } }
                );
              }
            } catch {}
            return resp;
          });
        }
      } catch {}

      // While ad-active, additional belt-and-braces ad-CDN block.
      try {
        if (window.__interceptify_ad_active &&
            /\/segments\/v\d+\/origins\/[a-f0-9]+\/sources\/[a-f0-9]+\//.test(url) &&
            /spotifycdn\.com/.test(url)) {
          return Promise.resolve(new Response(new ArrayBuffer(0), {
            status: 404, statusText: "Blocked by Interceptify (ad-active CDN)",
          }));
        }
      } catch {}

      // Capture interesting JSON bodies (metadata, pathfinder, manifests)
      const interesting =
        /\/metadata\/\d+\/track\//.test(url) ||
        /\/pathfinder\/v\d+\/query/.test(url) ||
        /\/sponsoredplaylist\/v\d+\/sponsored/.test(url) ||
        /\/manifests\/v\d+\/json\/sources\//.test(url);

      const promise = _f.apply(this, arguments);
      if (interesting) {
        promise.then(async (resp) => {
          try {
            const text = await resp.clone().text();
            window.__interceptify_meta_log.push({
              ts: Date.now(),
              adActive: !!window.__interceptify_ad_active,
              url: url.slice(0, 220),
              status: resp.status,
              bodyLen: text.length,
              body: text.slice(0, 4000),
            });
            if (window.__interceptify_meta_log.length > 60)
              window.__interceptify_meta_log = window.__interceptify_meta_log.slice(-30);
          } catch {}
        }).catch(() => {});
      }
      return promise;
    };
    window.fetch.__interceptify_hooked = true;
  }

  // ---- XMLHttpRequest sniffer ----
  if (XMLHttpRequest && !XMLHttpRequest.prototype.__interceptify_hooked) {
    const _o = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { snifferLog("xhr-open", { method, url: (url || "").slice(0, 220) }); } catch {}
      return _o.apply(this, arguments);
    };
    XMLHttpRequest.prototype.__interceptify_hooked = true;
  }

  // ---- WebSocket constructor wrap (catch the dealer) ----
  if (window.WebSocket && !window.WebSocket.__interceptify_hooked) {
    const _WS = window.WebSocket;
    const Wrapped = function (url, protocols) {
      try { snifferLog("ws-open", { url: (url || "").slice(0, 220) }); } catch {}
      const ws = new _WS(url, protocols);
      const _send = ws.send.bind(ws);
      ws.send = function (data) {
        try {
          const len = typeof data === "string" ? data.length : (data.byteLength || data.size || 0);
          const preview = typeof data === "string" ? data.slice(0, 200) : "<bin>";
          snifferLog("ws-send", { url: ws.url, len, preview });
        } catch {}
        return _send(data);
      };
      ws.addEventListener("message", (ev) => {
        try {
          const d = ev.data;
          const len = typeof d === "string" ? d.length : (d.byteLength || d.size || 0);
          const preview = typeof d === "string" ? d.slice(0, 200) : "<bin>";
          snifferLog("ws-recv", { url: ws.url, len, preview });
        } catch {}
      });
      return ws;
    };
    Wrapped.prototype = _WS.prototype;
    Wrapped.OPEN = _WS.OPEN; Wrapped.CLOSED = _WS.CLOSED;
    Wrapped.CONNECTING = _WS.CONNECTING; Wrapped.CLOSING = _WS.CLOSING;
    Wrapped.__interceptify_hooked = true;
    window.WebSocket = Wrapped;
  }

  // ---- navigator.sendBeacon (telemetry) ----
  if (navigator.sendBeacon && !navigator.sendBeacon.__interceptify_hooked) {
    const _sb = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      try { snifferLog("beacon", { url: (url || "").slice(0, 220) }); } catch {}
      return _sb(url, data);
    };
    navigator.sendBeacon.__interceptify_hooked = true;
  }

  // ---- EventSource (Server-Sent Events) ----
  if (window.EventSource && !window.EventSource.__interceptify_hooked) {
    const _ES = window.EventSource;
    const WrappedES = function (url, opts) {
      try { snifferLog("eventsource-open", { url: (url || "").slice(0, 220) }); } catch {}
      const es = new _ES(url, opts);
      es.addEventListener("message", (ev) => {
        try {
          const d = ev.data;
          snifferLog("eventsource-msg", { url, preview: (typeof d === "string" ? d : "").slice(0, 200) });
        } catch {}
      });
      return es;
    };
    WrappedES.prototype = _ES.prototype;
    WrappedES.__interceptify_hooked = true;
    window.EventSource = WrappedES;
  }

  // ---- BroadcastChannel (cross-renderer messaging) ----
  if (window.BroadcastChannel && !window.BroadcastChannel.__interceptify_hooked) {
    const _BC = window.BroadcastChannel;
    const WrappedBC = function (name) {
      const bc = new _BC(name);
      try { snifferLog("bc-open", { name }); } catch {}
      const _post = bc.postMessage.bind(bc);
      bc.postMessage = function (msg) {
        try { snifferLog("bc-post", { name, preview: JSON.stringify(msg).slice(0, 200) }); } catch {}
        return _post(msg);
      };
      bc.addEventListener("message", (ev) => {
        try { snifferLog("bc-recv", { name, preview: JSON.stringify(ev.data).slice(0, 200) }); } catch {}
      });
      return bc;
    };
    WrappedBC.prototype = _BC.prototype;
    WrappedBC.__interceptify_hooked = true;
    window.BroadcastChannel = WrappedBC;
  }

  // ---- MediaSource tracking + sourcebuffer instrumentation ----
  if (window.MediaSource && !MediaSource.prototype.__interceptify_hooked) {
    const _add = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.__interceptify_hooked = true;
    MediaSource.prototype.addSourceBuffer = function (mime) {
      window.__interceptify_mediasources.add(this);
      try { snifferLog("ms-addSourceBuffer", { mime, msUrl: this.__intercept_url }); } catch {}
      const sb = _add.apply(this, arguments);
      const _ap = sb.appendBuffer.bind(sb);
      sb.appendBuffer = function (data) {
        // While ad-active, refuse to append further audio chunks to any
        // existing MediaSource. The buffer will starve and Spotify's
        // player will signal end-of-stream → advances.
        if (window.__interceptify_ad_active) {
          try { snifferLog("ms-appendBuffer-BLOCKED", { size: data.byteLength || 0, mime }); } catch {}
          return; // silently drop
        }
        try { snifferLog("ms-appendBuffer", { size: data.byteLength || data.size || 0, mime }); } catch {}
        return _ap(data);
      };
      return sb;
    };
  }

  // URL.createObjectURL: tag MediaSource with its blob URL so we can correlate
  if (URL.createObjectURL && !URL.createObjectURL.__interceptify_hooked) {
    const _c = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (obj) {
      const u = _c(obj);
      try {
        if (obj instanceof MediaSource) obj.__intercept_url = u;
        snifferLog("createObjectURL", { url: u.slice(0, 80), kind: obj && obj.constructor && obj.constructor.name });
      } catch {}
      return u;
    };
    URL.createObjectURL.__interceptify_hooked = true;
  }

  // ---- Safe-skip guard ----
  // Block our own clicks on skip-forward / skip-back / playpause when the
  // ad UI isn't currently in the DOM. Stops the action loop from ruining
  // music on the very tick the ad transitions to a song.
  if (!window.__interceptify_safe_skip) {
    window.__interceptify_safe_skip = true;
    const adInDom = () => !!document.querySelector(
      '[data-testid="ad-controls"], [data-testid="ad-companion-card"], ' +
      '[data-testid="leavebehind-advertiser"], [data-testid="context-item-info-ad-subtitle"], ' +
      '[data-testid="video-takeover-link"], [data-testid="ad"]'
    );
    const fromOurScript = () => {
      const s = (new Error()).stack || "";
      return /interceptify-adblock|nuclearSkip|spamSeekForward|killVideoAd|forcePlayDuringAd|clickNextTrack|killCurrentMediaSources/.test(s);
    };
    const _click = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function () {
      try {
        const tid = this.getAttribute && this.getAttribute("data-testid");
        if (tid === "control-button-skip-forward" ||
            tid === "control-button-skip-back" ||
            tid === "control-button-playpause") {
          if (fromOurScript() && !adInDom()) return;
        }
      } catch {}
      return _click.apply(this, arguments);
    };
  }

  // killCurrentMediaSources: nuke any open MediaSource by signalling
  // end-of-stream. Spotify's player thinks the audio finished -> advances.
  function killCurrentMediaSources() {
    let killed = 0;
    try {
      window.__interceptify_mediasources.forEach((ms) => {
        try {
          if (ms.readyState === "open") {
            ms.endOfStream();
            killed++;
          }
        } catch {}
      });
    } catch {}
    if (killed) log("killed", killed, "MediaSource(s) via endOfStream");
    return killed;
  }
  window.__interceptify_killMediaSources = killCurrentMediaSources;

  // ---- Sniffer buffer expanded for 1-hour data collection ----
  // Bigger ring buffer + periodic snapshot to sessionStorage so we don't
  // lose data on tab refresh.
  setInterval(() => {
    try {
      const events = window.__interceptify_sniffer || [];
      if (events.length > 30000) {
        window.__interceptify_sniffer = events.slice(-15000);
      }
      // Snapshot small summary to sessionStorage so it survives reloads
      sessionStorage.setItem("__interceptify_summary", JSON.stringify({
        ts: Date.now(),
        snifferCount: events.length,
        adActiveCount: events.filter(e => e.adActive).length,
        metaLogCount: (window.__interceptify_meta_log || []).length,
        detections: window.__interceptify ? window.__interceptify.stats() : null,
      }));
    } catch {}
  }, 30000);

  // ---- PerformanceObserver: catches EVERY network resource ----
  // Belt-and-braces in case some fetch path bypasses our hooks.
  try {
    if (typeof PerformanceObserver !== "undefined" && !window.__interceptify_perfobs) {
      window.__interceptify_perfobs = true;
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          try {
            snifferLog("perf-resource", {
              name: (entry.name || "").slice(0, 220),
              initiatorType: entry.initiatorType,
              size: entry.transferSize || entry.encodedBodySize || 0,
              duration: Math.round(entry.duration),
            });
          } catch {}
        }
      });
      po.observe({ type: "resource", buffered: true });
    }
  } catch {}

  // ---- Service Worker registration tracker ----
  try {
    if (navigator.serviceWorker && !navigator.serviceWorker.__interceptify_hooked) {
      const _reg = navigator.serviceWorker.register.bind(navigator.serviceWorker);
      navigator.serviceWorker.register = function (url, opts) {
        try { snifferLog("sw-register", { url: (url || "").slice(0, 220), opts: JSON.stringify(opts || {}) }); } catch {}
        return _reg(url, opts);
      };
      navigator.serviceWorker.__interceptify_hooked = true;
    }
  } catch {}

  // ---- Worker constructor hook ----
  try {
    if (window.Worker && !window.Worker.__interceptify_hooked) {
      const _W = window.Worker;
      const Wrapped = function (url, opts) {
        try { snifferLog("worker-create", { url: (typeof url === "string" ? url : "<blob>").slice(0, 220) }); } catch {}
        return new _W(url, opts);
      };
      Wrapped.prototype = _W.prototype;
      Wrapped.__interceptify_hooked = true;
      window.Worker = Wrapped;
    }
  } catch {}

  // ---- localStorage / sessionStorage tracking for ad-related keys ----
  try {
    const trackStorage = (storage, label) => {
      const _set = storage.setItem.bind(storage);
      storage.setItem = function (k, v) {
        try {
          if (/ad|ads|sponsor|promot/i.test(k) && k !== "__interceptify_summary") {
            snifferLog(label + "-setItem", { key: k, valLen: (v || "").length, val: (v || "").slice(0, 200) });
          }
        } catch {}
        return _set(k, v);
      };
    };
    if (!localStorage.__interceptify_hooked) {
      trackStorage(localStorage, "localStorage");
      Object.defineProperty(localStorage, "__interceptify_hooked", { value: true });
    }
    if (!sessionStorage.__interceptify_hooked) {
      trackStorage(sessionStorage, "sessionStorage");
      Object.defineProperty(sessionStorage, "__interceptify_hooked", { value: true });
    }
  } catch {}

  // ---- Expand metadata-response capture to MORE endpoints ----
  // Add /track-playback/, /play-state/, /audio-url/, /content-feed/ etc.
  // (handled in the fetch hook above via the `interesting` regex; nothing
  // to do here unless we want to add more — current set is good baseline)

  // ---- MutationObserver on <body> to record EXACT ad UI mount time ----
  try {
    if (!window.__interceptify_mo_installed) {
      window.__interceptify_mo_installed = true;
      const startup = () => {
        if (!document.body) return setTimeout(startup, 100);
        const mo = new MutationObserver((muts) => {
          for (const m of muts) {
            for (const node of m.addedNodes) {
              if (node.nodeType !== 1) continue;
              try {
                const id = node.getAttribute && node.getAttribute("data-testid");
                if (id && /^(ad|ads|leavebehind|video-takeover|sponsor|context-item-info-ad)/.test(id)) {
                  snifferLog("dom-ad-mount", { testid: id });
                }
              } catch {}
            }
          }
        });
        mo.observe(document.body, { childList: true, subtree: true, attributes: false });
      };
      startup();
    }
  } catch {}

  // ===================================================================
  // END EARLY HOOKS
  // ===================================================================

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
    // Audio + visible "context" ads
    '[data-testid="context-item-info-ad-title"]',
    '[data-testid="context-item-info-ad-subtitle"]',
    '[data-testid="ad-controls"]',
    '[data-testid="ad-companion-card"]',
    '[data-testid="ad-countdown-timer"]',
    '[data-testid="leavebehind-advertiser"]',
    // Video / canvas ads
    '[data-testid="ads-video-player-npv"]',
    '[data-testid="standalone-video-ad-player"]',
    '[data-testid="canvas-ad-player"]',
    '[data-testid="canvas-ad-container"]',
    '[data-testid="video-takeover-link"]',
    // Generic
    '[data-testid="context-item-info"][aria-label*="Advertisement" i]',
    '[aria-label*="Advertisement" i][data-testid*="track"]',
  ];
  // Visual-only ad surfaces — we hide them via CSS rather than skip/mute.
  // Includes everything that's a banner / carousel / promotion shelf.
  const VISUAL_AD_SELECTORS = [
    '[data-testid="embedded-ad"]',
    '[data-testid="embedded-ad-carousel"]',
    '[data-testid="home-ad-card"]',
    '[data-testid="home-ads-container"]',
    '[data-testid="sponsored-recommendation-modal-trigger"]',
    '[data-testid="ad-companion-card"]',           // companion banner shown alongside audio ads
    '[data-testid="ad-companion-card-tagline"]',   // its tagline
    '[data-testid="leavebehind-advertiser"]',      // banner that persists after audio ad
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

  // ------------------------------------------------------------------
  // (Pre-player video-block removed -- it was too broad, killed podcast
  // and Canvas video. To be replaced by manifest-classifier once we have
  // sample data of ad-manifest vs music/podcast-manifest bodies.)
  // ------------------------------------------------------------------
  // Low-level crippling — hooks that prevent ad audio/video from ever
  // reaching the speakers / screen, no matter what Spotify's player does.
  // Activated by window.__interceptify_ad_active which the detection
  // loop below toggles in lockstep with the badge state.
  // ------------------------------------------------------------------
  window.__interceptify_ad_active = false;

  // (a) Master-gain interception. Every AudioNode that wires up to a
  //     speaker (AudioDestinationNode) is rerouted through a per-context
  //     GainNode we own. Setting that gain to 0 mutes everything Spotify
  //     emits, regardless of source type (BufferSource, MediaElementSource,
  //     OscillatorNode, etc.).
  try {
    if (!AudioNode.prototype.__interceptify_connect_hooked) {
      const origConnect = AudioNode.prototype.connect;
      AudioNode.prototype.__interceptify_connect_hooked = true;
      AudioNode.prototype.connect = function (target, ...rest) {
        try {
          if (target && target instanceof AudioDestinationNode) {
            const ctx = target.context;
            if (!ctx.__interceptify_master) {
              const g = ctx.createGain();
              g.gain.value = window.__interceptify_ad_active ? 0 : 1;
              origConnect.call(g, target);
              ctx.__interceptify_master = g;
            }
            return origConnect.call(this, ctx.__interceptify_master, ...rest);
          }
        } catch {}
        return origConnect.call(this, target, ...rest);
      };
    }
  } catch {}

  // (b) Track every AudioContext so we can flip its master-gain on demand.
  try {
    const _AC = window.AudioContext || window.webkitAudioContext;
    if (_AC && !_AC.__interceptify_wrapped) {
      const Wrapped = function (...a) {
        const c = new _AC(...a);
        (window.__interceptify_audioContexts = window.__interceptify_audioContexts || new Set()).add(c);
        return c;
      };
      Wrapped.prototype = _AC.prototype;
      Wrapped.__interceptify_wrapped = true;
      window.AudioContext = Wrapped;
      if (window.webkitAudioContext) window.webkitAudioContext = Wrapped;
    }
  } catch {}

  // (c) Block <video>.play() during ads — resolve immediately and synthesize
  //     'ended' so Spotify's listener advances the queue.
  try {
    if (!HTMLMediaElement.prototype.__interceptify_play_hooked) {
      const origPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.__interceptify_play_hooked = true;
      HTMLMediaElement.prototype.play = function () {
        if (window.__interceptify_ad_active && this.tagName === "VIDEO") {
          try { this.muted = true; this.volume = 0; } catch {}
          const v = this;
          setTimeout(() => {
            try { v.dispatchEvent(new Event("ended", { bubbles: true })); } catch {}
          }, 10);
          return Promise.resolve();
        }
        return origPlay.apply(this, arguments);
      };
    }
  } catch {}

  // (d) Refuse blob: src on <video> while ad-active. Spotify's ad video
  //     comes via a MediaSource blob URL; dropping the assignment means
  //     the video element never gets a source to play from.
  try {
    const proto = HTMLMediaElement.prototype;
    const srcDesc = Object.getOwnPropertyDescriptor(proto, "src");
    if (srcDesc && srcDesc.set && !proto.__interceptify_src_hooked) {
      proto.__interceptify_src_hooked = true;
      Object.defineProperty(proto, "src", {
        configurable: true,
        get: srcDesc.get,
        set(v) {
          if (window.__interceptify_ad_active && this.tagName === "VIDEO" &&
              typeof v === "string" && v.startsWith("blob:")) {
            return;
          }
          return srcDesc.set.call(this, v);
        },
      });
    }
  } catch {}

  // (e) Apply ad-active to every known master gain in real time.
  function applyAdActiveGains(active) {
    if (!window.__interceptify_audioContexts) return;
    for (const ctx of window.__interceptify_audioContexts) {
      try {
        if (ctx.__interceptify_master) {
          ctx.__interceptify_master.gain.setValueAtTime(active ? 0 : 1, ctx.currentTime);
        }
      } catch {}
    }
  }
  // ------------------------------------------------------------------

  // Hook Spotify's internal event-emitter pattern. The xpui code does things
  // like  n.on("adplaying", cb)  and  n.emit("adbreakstart").
  // Spotify's full ad lifecycle (verified via static analysis 2026-04-29):
  //   adrequest -> adresponse -> adbreakstart -> adplay -> adplaying ->
  //   adfirstquartile -> admidpoint -> adended -> adbreakend
  //   Plus: adpause, aderror, adclicked
  // We treat any of the "starting" events as ad-on, "ending" events as ad-off.
  let eventBasedAd = false;
  const AD_START_EVENTS = /^(adrequest|adresponse|adbreakstart|adplay|adplaying|adfirstquartile|admidpoint)$/i;
  const AD_END_EVENTS = /^(adended|adbreakend|aderror)$/i;
  function tryHookEmitter(proto, methodName) {
    if (!proto || typeof proto[methodName] !== "function" || proto["__interceptify_" + methodName]) return;
    const orig = proto[methodName];
    proto["__interceptify_" + methodName] = true;
    proto[methodName] = function (eventName, handler, ...rest) {
      try {
        if (typeof eventName === "string") {
          if (AD_START_EVENTS.test(eventName)) {
            eventBasedAd = true;
            log("event-emitter ad signal:", eventName);
          } else if (AD_END_EVENTS.test(eventName)) {
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

  // Spotify's Sponsored Session / video takeover ads put a real <video>
  // element in the DOM with a blob: src. The standard skip button is
  // disabled and there's no seek-forward-15 -- but dispatching an 'ended'
  // event on the video makes Spotify's listener think it finished, and it
  // advances the queue. We also crank playbackRate to 16x and seek to
  // duration as belt-and-braces. Verified live 2026-04-29.
  function killVideoAd() {
    const v = document.querySelector("video");
    if (!v || !isFinite(v.duration) || v.duration <= 0) return false;
    try { v.muted = true; v.volume = 0; } catch {}
    try { v.playbackRate = 16; } catch {}
    try { v.currentTime = v.duration - 0.05; } catch {}
    try { v.dispatchEvent(new Event("ended", { bubbles: true })); } catch {}
    return true;
  }

  // If Spotify is paused mid-ad, our seek-forward spam can't actually
  // advance the playhead -- audio has to be playing. So when an ad is
  // detected and the play/pause button shows the "play" affordance
  // (i.e. currently paused), click play to start the ad audio. The mute
  // is already on, so the user hears nothing.
  function forcePlayDuringAd() {
    const pp = document.querySelector('[data-testid="control-button-playpause"]');
    if (!pp) return;
    const aria = pp.getAttribute("aria-label") || "";
    if (/^(play|spela)/i.test(aria)) {
      try { pp.click(); } catch {}
    }
  }

  // --- Nuclear skip: fire every tool we have on every ad tick. -------------
  // Don't differentiate ad type, don't rely on detection of which button is
  // present -- just spray every known mechanism. The ones that don't apply
  // are no-ops; the ones that do, fire.
  function nuclearSkip() {
    // 1. Click every skip-ish button, even if "disabled" (sometimes React
    //    onClick still fires)
    const buttonIds = [
      "control-button-skip-forward",
      "control-button-seek-forward-15",
      "control-button-skip-back",
      "control-button-seek-back-15",
    ];
    for (const id of buttonIds) {
      document.querySelectorAll('[data-testid="' + id + '"]').forEach((b) => {
        try { b.click(); } catch {}
      });
    }
    // 2. Spam the seek-forward-15 (when it exists) extra times
    const fwd15 = document.querySelector('[data-testid="control-button-seek-forward-15"]');
    if (fwd15) {
      for (let i = 0; i < 8; i++) { try { fwd15.click(); } catch {} }
    }
    // 3. Force-play if paused (so seeks actually advance)
    forcePlayDuringAd();
    // 4. Set the progress slider value to its max via React-friendly setter
    document.querySelectorAll('[data-testid="playback-progressbar"] input[type="range"]').forEach((inp) => {
      try {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(inp, inp.max);
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
      } catch {}
    });
    // 5. Simulate a mouse click on the far-right edge of the progress bar
    //    (the user-equivalent of "click here to seek")
    const bar = document.querySelector('[data-testid="progress-bar"]');
    if (bar) {
      try {
        const r = bar.getBoundingClientRect();
        const x = r.right - 2;
        const y = r.top + r.height / 2;
        const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
        for (const ev of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          bar.dispatchEvent(new (window.PointerEvent && /^pointer/.test(ev) ? PointerEvent : MouseEvent)(ev, opts));
        }
      } catch {}
    }
    // 6. Kill all video elements
    document.querySelectorAll("video").forEach((v) => {
      try { v.muted = true; v.volume = 0; } catch {}
      try { v.playbackRate = 16; } catch {}
      if (isFinite(v.duration) && v.duration > 0) {
        try { v.currentTime = v.duration - 0.05; } catch {}
      }
      try { v.dispatchEvent(new Event("ended", { bubbles: true })); } catch {}
      try { v.pause(); } catch {}
    });
    // 7. Force-mute every <audio> element (rare on this build but cheap)
    document.querySelectorAll("audio").forEach((a) => {
      try { a.muted = true; a.volume = 0; } catch {}
      if (isFinite(a.duration) && a.duration > 0) {
        try { a.currentTime = a.duration - 0.05; } catch {}
      }
      try { a.dispatchEvent(new Event("ended", { bubbles: true })); } catch {}
    });
    // 8. Fire keyboard shortcuts that Spotify maps to seek/next
    //    Right arrow = seek forward, Shift+Right = next track (Spotify Web)
    try {
      const target = document.activeElement || document.body;
      for (const init of [
        { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
        { key: "ArrowRight", code: "ArrowRight", keyCode: 39, shiftKey: true },
        { key: "ArrowRight", code: "ArrowRight", keyCode: 39, ctrlKey: true },
        { key: "End", code: "End", keyCode: 35 },
      ]) {
        target.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true }));
        target.dispatchEvent(new KeyboardEvent("keyup",   { ...init, bubbles: true }));
      }
    } catch {}
  }
  // -------------------------------------------------------------------------

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
        // Flip the low-level switch -- mutes every existing AudioContext
        // master gain to 0 and arms the video.play() / video.src hijacks.
        window.__interceptify_ad_active = true;
        applyAdActiveGains(true);
      }
      // KITCHEN SINK: fire every conceivable skip + mute mechanism on
      // every detection tick. Don't differentiate by ad type, don't try
      // to be smart -- just throw all available tools at the problem.
      // No-ops are free.
      nuclearSkip();
      // Plus: surgical kill of the underlying media stream. The fetch
      // hook above already returns 404 for new ad-CDN segments while
      // ad-active; calling endOfStream() on the open MediaSource forces
      // Spotify's player to fire its 'ended' handler and advance.
      try { killCurrentMediaSources(); } catch {}
    } else if (!detected && wasAd) {
      log("ad ended");
      setBadgeState("idle");
      muteAllAudio(false);
      window.__interceptify_ad_active = false;
      applyAdActiveGains(false);
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
