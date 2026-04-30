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
  const DEBUG_CAPTURE = window.__INTERCEPTIFY_DEBUG_CAPTURE === true;
  const blockInStreamSignal = () => window.__INTERCEPTIFY_BLOCK_INSTREAM_SIGNAL !== false;

  // ===================================================================
  // EARLY HOOKS — must install before Spotify's deferred xpui-snapshot.js
  // runs, so we catch the dealer WebSocket and the very first fetches.
  // ===================================================================

  // Shared state
  window.__interceptify_ad_active = false;
  window.__interceptify_sniffer = window.__interceptify_sniffer || [];
  window.__interceptify_meta_log = window.__interceptify_meta_log || [];
  window.__interceptify_mediasources = window.__interceptify_mediasources || new Set();
  window.__interceptify_known_ad_sources = window.__interceptify_known_ad_sources || new Set();
  window.__interceptify_ad_intel = window.__interceptify_ad_intel || {
    manifests: [],
    blockedSources: [],
    blockedSegments: [],
    instreamAds: [],
    instreamApiCalls: [],
    adPlays: [],
  };

  function snifferLog(kind, info) {
    if (!DEBUG_CAPTURE) return;
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

  function nowPlayingSnapshot() {
    try {
      const title =
        document.querySelector('[data-testid="context-item-link"]') ||
        document.querySelector('[data-testid="context-item-info-title"]') ||
        document.querySelector('[data-testid="now-playing-widget"] a');
      const subtitle =
        document.querySelector('[data-testid="context-item-info-subtitle"]') ||
        document.querySelector('[data-testid="context-item-info-ad-subtitle"]');
      return {
        documentTitle: document.title,
        title: (title && title.textContent || "").trim().slice(0, 160),
        subtitle: (subtitle && subtitle.textContent || "").trim().slice(0, 160),
      };
    } catch {
      return {};
    }
  }

  function rememberIntel(bucket, info) {
    if (!DEBUG_CAPTURE) return;
    try {
      const intel = window.__interceptify_ad_intel;
      const arr = intel[bucket] || (intel[bucket] = []);
      arr.push({
        ts: Date.now(),
        adActive: !!window.__interceptify_ad_active,
        nowPlaying: nowPlayingSnapshot(),
        ...info,
      });
      if (arr.length > 200) intel[bucket] = arr.slice(-120);
    } catch {}
  }

  function installSuppressionCss() {
    try {
      if (document.getElementById("interceptify-suppress-css")) return;
      const style = document.createElement("style");
      style.id = "interceptify-suppress-css";
      style.textContent = [
        'html[data-interceptify-ad-suppressed="true"] [data-testid*="ad" i] { display:none !important; visibility:hidden !important; opacity:0 !important; pointer-events:none !important; }',
        'html[data-interceptify-ad-suppressed="true"] [data-testid*="sponsor" i] { display:none !important; visibility:hidden !important; opacity:0 !important; pointer-events:none !important; }',
        'html[data-interceptify-ad-suppressed="true"] [data-testid*="premium" i] { display:none !important; visibility:hidden !important; opacity:0 !important; pointer-events:none !important; }',
        'html[data-interceptify-ad-suppressed="true"] [data-testid="context-item-info"] { visibility:hidden !important; opacity:0 !important; }',
        'html[data-interceptify-ad-suppressed="true"] [data-testid="now-playing-widget"] { visibility:hidden !important; opacity:0 !important; }',
        'html[data-interceptify-ad-suppressed="true"] [data-testid="now-playing-bar"] a[href*="/premium"] { display:none !important; }',
        'html[data-interceptify-ad-suppressed="true"] iframe[src*="ad"], html[data-interceptify-ad-suppressed="true"] iframe[id*="ad"] { display:none !important; visibility:hidden !important; }',
      ].join("\n");
      (document.head || document.documentElement).appendChild(style);
    } catch {}
  }

  function suppressAdUi(reason, ms) {
    try {
      installSuppressionCss();
      const until = Date.now() + (ms || 2500);
      window.__interceptify_suppress_ad_ui_until = Math.max(window.__interceptify_suppress_ad_ui_until || 0, until);
      document.documentElement.setAttribute("data-interceptify-ad-suppressed", "true");
      snifferLog("ad-ui-suppress", { reason, until });
      setTimeout(() => {
        try {
          if (Date.now() >= (window.__interceptify_suppress_ad_ui_until || 0)) {
            document.documentElement.removeAttribute("data-interceptify-ad-suppressed");
          }
        } catch {}
      }, (ms || 2500) + 50);
    } catch {}
  }
  installSuppressionCss();

  function extractManifestMaxEnd(text) {
    let maxEnd = 0;
    try {
      const visit = (v) => {
        if (!v || typeof v !== "object") return;
        if (typeof v.end_time_millis === "number") maxEnd = Math.max(maxEnd, v.end_time_millis);
        if (typeof v.duration_millis === "number") maxEnd = Math.max(maxEnd, v.duration_millis);
        if (typeof v.duration_ms === "number") maxEnd = Math.max(maxEnd, v.duration_ms);
        if (Array.isArray(v)) {
          v.forEach(visit);
        } else {
          Object.keys(v).forEach((k) => visit(v[k]));
        }
      };
      visit(JSON.parse(text));
    } catch {}
    try {
      const matches = text.match(/"(?:end_time_millis|duration_millis|duration_ms)"\s*:\s*(\d+)/g) || [];
      for (const m of matches) {
        const n = parseInt((m.match(/(\d+)/) || [0, 0])[1], 10);
        if (Number.isFinite(n)) maxEnd = Math.max(maxEnd, n);
      }
    } catch {}
    return maxEnd;
  }

  function emptyManifestResponse() {
    return new Response(
      JSON.stringify({ contents: [] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  function compactValue(value, depth = 0) {
    if (value == null) return value;
    if (typeof value === "string") return value.slice(0, 600);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "function") return "[Function]";
    if (depth > 3) return "[DepthLimit]";
    if (Array.isArray(value)) return value.slice(0, 20).map((v) => compactValue(v, depth + 1));
    if (typeof value === "object") {
      const out = {};
      Object.keys(value).slice(0, 80).forEach((k) => {
        try { out[k] = compactValue(value[k], depth + 1); } catch {}
      });
      return out;
    }
    return String(value).slice(0, 200);
  }

  function summarizeAdObject(ad) {
    if (!ad || typeof ad !== "object") return null;
    const metadata = ad.metadata || {};
    const summary = {
      id: ad.id,
      adId: ad.adId,
      requestId: ad.requestId,
      uri: ad.uri,
      slot: ad.slot,
      mediaType: ad.mediaType,
      isPodcastAd: ad.isPodcastAd,
      isDsaEligible: ad.isDsaEligible,
      clickthroughUrl: ad.clickthroughUrl,
      advertiser: ad.advertiser || metadata.advertiser,
      creativeId: metadata.creative_id,
      lineitemId: metadata.lineitem_id,
      buttonMessage: metadata.buttonMessage,
      tagline: metadata.tagline,
      logoImage: metadata.logoImage || ad.logoImage,
      images: compactValue(ad.images),
      metadata: compactValue(metadata),
    };
    if (!summary.id && !summary.adId && !summary.uri && !summary.clickthroughUrl && !summary.advertiser) {
      return null;
    }
    return summary;
  }

  function rememberInStreamAd(ad, reason) {
    try {
      const summary = summarizeAdObject(ad);
      if (!summary) return;
      suppressAdUi(reason || "instream-ad", 3000);
      const key = [
        summary.adId || summary.id || "",
        summary.requestId || "",
        summary.uri || "",
        summary.clickthroughUrl || "",
      ].join("|");
      window.__interceptify_seen_instream_ads = window.__interceptify_seen_instream_ads || new Set();
      if (key && window.__interceptify_seen_instream_ads.has(key)) return;
      if (key) window.__interceptify_seen_instream_ads.add(key);
      rememberIntel("instreamAds", { reason, ad: summary });
      snifferLog("instream-ad", {
        reason,
        id: summary.adId || summary.id,
        advertiser: summary.advertiser,
        uri: summary.uri,
        clickthroughUrl: (summary.clickthroughUrl || "").slice(0, 220),
      });
      window.__interceptify_instream_ad_until = Date.now() + 3000;
      try {
        window.__interceptify_ad_active = true;
        setBadgeState("ad");
        muteAllAudio(true);
        applyAdActiveGains(true);
      } catch {}
    } catch {}
  }

  function inStreamAdKey(ad) {
    try {
      const summary = summarizeAdObject(ad);
      if (!summary) return "";
      return [
        summary.adId || summary.id || "",
        summary.requestId || "",
        summary.uri || "",
        summary.clickthroughUrl || "",
      ].join("|");
    } catch {}
    return "";
  }

  function rememberInStreamApiCall(method, info) {
    if (!DEBUG_CAPTURE) return;
    try {
      rememberIntel("instreamApiCalls", {
        method,
        ...compactValue(info || {}, 0),
      });
      snifferLog("instream-api-call", {
        method,
        hasAd: !!(info && info.ad),
        argCount: info && info.argCount,
      });
    } catch {}
  }

  function inStreamAdFromMessage(value) {
    if (!value || typeof value !== "object") return null;
    return value.ad || value.inStreamAd || value.instreamAd || null;
  }

  function looksLikeInStreamAdMessage(value) {
    try {
      const ad = inStreamAdFromMessage(value);
      if (summarizeAdObject(ad)) return true;
      const selfSummary = summarizeAdObject(value);
      if (selfSummary && (selfSummary.creativeId || selfSummary.lineitemId || selfSummary.advertiser)) return true;
      const preview = JSON.stringify(compactValue(value, 0));
      return /Spotify Ad Server|audio_ad|creative_id|lineitem_id/.test(preview) &&
        /advertiser|requestId|adId|inStream/i.test(preview);
    } catch {}
    return false;
  }

  function maybeRememberInStreamMessage(method, value) {
    try {
      const msg = value && typeof value === "object" ? value : null;
      const ad = inStreamAdFromMessage(msg);
      if (ad) {
        rememberInStreamAd(ad, method);
        rememberInStreamApiCall(method, { ad: summarizeAdObject(ad), message: compactValue(msg, 0) });
        return true;
      }
      if (summarizeAdObject(msg)) {
        rememberInStreamAd(msg, method);
        rememberInStreamApiCall(method, { ad: summarizeAdObject(msg), message: compactValue(msg, 0) });
        return true;
      }
      if (msg && /ad/i.test(JSON.stringify(compactValue(msg, 0)))) {
        rememberInStreamApiCall(method, { message: compactValue(msg, 0) });
      }
    } catch {}
    return false;
  }

  function neutralizeInStreamAd(api, ad, reason) {
    const summary = summarizeAdObject(ad);
    if (!summary) return false;
    suppressAdUi(reason || "neutralize", 3000);
    rememberInStreamAd(ad, reason);
    rememberInStreamApiCall(`${reason}.neutralize`, { ad: summary });
    if (!blockInStreamSignal()) return false;
    try {
      const key = inStreamAdKey(ad) || `${Date.now()}`;
      window.__interceptify_neutralized_ads = window.__interceptify_neutralized_ads || new Set();
      if (!window.__interceptify_neutralized_ads.has(key)) {
        window.__interceptify_neutralized_ads.add(key);
        if (api && typeof api.skipToNext === "function") {
          try {
            rememberInStreamApiCall("skipToNext.forAd", { ad: summary });
            api.skipToNext();
          } catch (e) {
            rememberInStreamApiCall("skipToNext.error", { error: String(e && e.message || e) });
          }
        }
      }
      if (api && api.__interceptify_set_instream_ad) {
        api.__interceptify_set_instream_ad(null);
      } else if (api && Object.prototype.hasOwnProperty.call(api, "inStreamAd")) {
        api.inStreamAd = null;
      }
    } catch {}
    return true;
  }

  function wrapInStreamCallback(callback, reason) {
    if (typeof callback !== "function") return callback;
    if (callback.__interceptify_wrapped) return callback;
    window.__interceptify_callback_wrappers = window.__interceptify_callback_wrappers || new WeakMap();
    const existing = window.__interceptify_callback_wrappers.get(callback);
    if (existing) return existing;
    const wrapped = function () {
      const args = Array.from(arguments);
      const hasAdPayload = args.some((value) => maybeRememberInStreamMessage(`${reason}.callback`, value));
      rememberInStreamApiCall(`${reason}.callback`, {
        argCount: args.length,
        args: compactValue(args, 0),
      });
      if (hasAdPayload && blockInStreamSignal()) {
        rememberInStreamApiCall(`${reason}.callback.blocked`, {
          argCount: args.length,
          args: compactValue(args, 0),
        });
        return undefined;
      }
      return callback.apply(this, arguments);
    };
    wrapped.__interceptify_wrapped = true;
    wrapped.__interceptify_original = callback;
    window.__interceptify_callback_wrappers.set(callback, wrapped);
    return wrapped;
  }

  function wrapCallbackCollection(collection, reason) {
    if (!collection || collection.__interceptify_callbacks_wrapped) return collection;
    try {
      if (collection instanceof Set) {
        const values = Array.from(collection);
        collection.clear();
        values.forEach((value) => collection.add(wrapInStreamCallback(value, reason)));
        const originalAdd = collection.add;
        collection.add = function (value) {
          rememberInStreamApiCall(`${reason}.add`, { valueType: typeof value });
          return originalAdd.call(this, wrapInStreamCallback(value, reason));
        };
        collection.__interceptify_callbacks_wrapped = true;
        rememberInStreamApiCall(`${reason}.wrapped-set`, { size: collection.size });
        return collection;
      }
      if (Array.isArray(collection)) {
        for (let i = 0; i < collection.length; i++) {
          collection[i] = wrapInStreamCallback(collection[i], reason);
        }
        ["push", "unshift"].forEach((method) => {
          const original = collection[method];
          collection[method] = function () {
            const values = Array.from(arguments).map((value) => wrapInStreamCallback(value, reason));
            rememberInStreamApiCall(`${reason}.${method}`, { count: values.length });
            return original.apply(this, values);
          };
        });
        const originalSplice = collection.splice;
        collection.splice = function (start, deleteCount) {
          const rest = Array.prototype.slice.call(arguments, 2).map((value) => wrapInStreamCallback(value, reason));
          rememberInStreamApiCall(`${reason}.splice`, { count: rest.length });
          return originalSplice.apply(this, [start, deleteCount, ...rest]);
        };
        collection.__interceptify_callbacks_wrapped = true;
        rememberInStreamApiCall(`${reason}.wrapped-array`, { length: collection.length });
        return collection;
      }
      if (typeof collection === "function") {
        return wrapInStreamCallback(collection, reason);
      }
      rememberInStreamApiCall(`${reason}.unknown-collection`, {
        type: typeof collection,
        keys: Object.keys(collection || {}).slice(0, 30),
      });
    } catch (e) {
      rememberInStreamApiCall(`${reason}.wrap-error`, { error: String(e && e.message || e) });
    }
    return collection;
  }

  function wrapAdMessageCallbackSlot(api, reason) {
    if (!api || api.__interceptify_callback_slot_wrapped) return;
    try {
      const existing = api.onAdMessageCallbacks;
      let currentCallbacks = wrapCallbackCollection(existing, `${reason}.onAdMessageCallbacks`);
      Object.defineProperty(api, "onAdMessageCallbacks", {
        configurable: true,
        enumerable: true,
        get() {
          return currentCallbacks;
        },
        set(value) {
          currentCallbacks = wrapCallbackCollection(value, `${reason}.onAdMessageCallbacks`);
        },
      });
      api.__interceptify_callback_slot_wrapped = true;
    } catch (e) {
      rememberInStreamApiCall("onAdMessageCallbacks.wrap-error", { reason, error: String(e && e.message || e) });
    }
  }

  function wrapInStreamApi(api, reason) {
    if (!api || typeof api !== "object" || api.__interceptify_api_wrapped) return api;
    try {
      window.__interceptify_instream_api = api;
      wrapAdMessageCallbackSlot(api, reason);
      try {
        const existing = api.inStreamAd;
        let currentInStreamAd = existing && summarizeAdObject(existing) && blockInStreamSignal() ? null : existing;
        api.__interceptify_set_instream_ad = (value) => { currentInStreamAd = value; };
        Object.defineProperty(api, "inStreamAd", {
          configurable: true,
          enumerable: true,
          get() {
            const hasAd = summarizeAdObject(currentInStreamAd);
            if (hasAd && blockInStreamSignal()) {
              neutralizeInStreamAd(api, currentInStreamAd, "inStreamAd.get");
              return null;
            }
            return currentInStreamAd;
          },
          set(value) {
            if (summarizeAdObject(value)) {
              rememberInStreamApiCall("inStreamAd.set", { ad: summarizeAdObject(value) });
              if (blockInStreamSignal()) {
                neutralizeInStreamAd(api, value, "inStreamAd.set");
                currentInStreamAd = null;
                return;
              }
            }
            currentInStreamAd = value;
          },
        });
        if (summarizeAdObject(existing)) neutralizeInStreamAd(api, existing, "inStreamAd.initial");
      } catch (e) {
        rememberInStreamApiCall("inStreamAd.wrap-error", { error: String(e && e.message || e) });
      }
      const names = new Set();
      let cur = api;
      while (cur && cur !== Object.prototype) {
        Object.getOwnPropertyNames(cur).forEach((name) => names.add(name));
        cur = Object.getPrototypeOf(cur);
      }
      rememberInStreamApiCall("api-discovered", {
        reason,
        methods: Array.from(names).filter((name) => typeof api[name] === "function").sort(),
        keys: Object.keys(api || {}).sort(),
      });
      names.forEach((name) => {
        if (name === "constructor" || typeof api[name] !== "function") return;
        if (api[name].__interceptify_wrapped) return;
        const original = api[name];
        api[name] = function () {
          const args = Array.from(arguments);
          const wrappedArgs = args.map((arg, index) => {
            if (typeof arg !== "function") return arg;
            rememberInStreamApiCall(`${name}.callback-wrapped`, { index });
            return wrapInStreamCallback(arg, name);
          });
          rememberInStreamApiCall(name, {
            argCount: args.length,
            args: compactValue(args, 0),
          });
          const hasAdPayload = args.some((value) => {
            const remembered = maybeRememberInStreamMessage(`${name}.arg`, value);
            return remembered || looksLikeInStreamAdMessage(value);
          });
          if (hasAdPayload && blockInStreamSignal() && /processMessage|set|notify|emit|publish/i.test(name)) {
            rememberInStreamApiCall(`${name}.blocked`, {
              argCount: args.length,
              args: compactValue(args, 0),
            });
            return undefined;
          }
          const result = original.apply(this, wrappedArgs);
          maybeRememberInStreamMessage(`${name}.return`, result);
          if (result && typeof result.then === "function") {
            result.then((value) => maybeRememberInStreamMessage(`${name}.promise`, value)).catch(() => {});
          }
          if (name === "getInStreamAd" && summarizeAdObject(result) && blockInStreamSignal()) {
            neutralizeInStreamAd(api, result, "getInStreamAd.return");
            return null;
          }
          return result;
        };
        api[name].__interceptify_wrapped = true;
        api[name].__interceptify_original = original;
      });
      api.__interceptify_api_wrapped = true;
    } catch (e) {
      rememberInStreamApiCall("api-wrap-error", { reason, error: String(e && e.message || e) });
    }
    return api;
  }

  function wrapInStreamExports(exportsObj) {
    if (!exportsObj || exportsObj.__interceptify_instream_hooked) return;
    try {
      if (typeof exportsObj.m === "function" && !exportsObj.m.__interceptify_wrapped) {
        const orig = exportsObj.m;
        const wrapped = function () {
          const ad = orig.apply(this, arguments);
          rememberInStreamAd(ad, "webpack-46849.m");
          return ad;
        };
        wrapped.__interceptify_wrapped = true;
        exportsObj.m = wrapped;
      }
      if (typeof exportsObj.d === "function" && !exportsObj.d.__interceptify_wrapped) {
        const orig = exportsObj.d;
        const wrapped = function () {
          const api = wrapInStreamApi(orig.apply(this, arguments), "webpack-46849.d");
          try {
            if (api && typeof api.getInStreamAd === "function" && !api.getInStreamAd.__interceptify_wrapped) {
              const origGet = api.getInStreamAd;
              api.getInStreamAd = function () {
                const ad = origGet.apply(this, arguments);
                rememberInStreamAd(ad, "webpack-46849.d.getInStreamAd");
                return ad;
              };
              api.getInStreamAd.__interceptify_wrapped = true;
            }
          } catch {}
          return api;
        };
        wrapped.__interceptify_wrapped = true;
        exportsObj.d = wrapped;
      }
      exportsObj.__interceptify_instream_hooked = true;
    } catch {}
  }

  function installWebpackAdProviderHook() {
    if (window.__interceptify_webpack_ad_hooked) return;
    window.__interceptify_webpack_ad_hooked = true;
    try {
      const chunk = window.webpackChunkclient_web = window.webpackChunkclient_web || [];
      const makeWrappedFactory = (originalFactory) => {
        const wrappedFactory = function (module, exports, require) {
          try {
            const source = String(originalFactory);
            if (source.includes("getInStreamAd") && source.includes("inStreamApi") && require.d) {
              const playerState = require(5563);
              const getApi = () => (0, playerState.G)().inStreamApi;
              const wrappedD = () => {
                const api = wrapInStreamApi(getApi(), "webpack-46849.replaced.d");
                try {
                  if (api && typeof api.getInStreamAd === "function" && !api.getInStreamAd.__interceptify_wrapped) {
                    const origGet = api.getInStreamAd;
                    api.getInStreamAd = function () {
                      const ad = origGet.apply(this, arguments);
                      rememberInStreamAd(ad, "webpack-46849.replaced.getInStreamAd");
                      return ad;
                    };
                    api.getInStreamAd.__interceptify_wrapped = true;
                  }
                } catch {}
                return api;
              };
              const wrappedM = () => {
                const ad = wrappedD().getInStreamAd();
                rememberInStreamAd(ad, "webpack-46849.replaced.m");
                return ad;
              };
              require.d(exports, { d: () => wrappedD, m: () => wrappedM });
              snifferLog("webpack-module-replaced", { module: "46849" });
              return undefined;
            }
          } catch {}
          const result = originalFactory.apply(this, arguments);
          try { wrapInStreamExports(module && module.exports || exports); } catch {}
          return result;
        };
        wrappedFactory.__interceptify_wrapped = true;
        return wrappedFactory;
      };
      const patchModules = (modules) => {
        try {
          const key = modules && (modules[46849] ? 46849 : (modules["46849"] ? "46849" : null));
          if (key == null || modules[key].__interceptify_wrapped) return;
          modules[key] = makeWrappedFactory(modules[key]);
          snifferLog("webpack-module-hooked", { module: "46849" });
        } catch {}
      };
      const patchRequire = (require) => {
        try {
          if (require && require.m && require.m[46849] && !require.m[46849].__interceptify_wrapped) {
            require.m[46849] = makeWrappedFactory(require.m[46849]);
            if (require.c && require.c[46849]) delete require.c[46849];
            snifferLog("webpack-runtime-module-hooked", { module: "46849" });
          }
        } catch {}
      };
      chunk.forEach((payload) => patchModules(payload && payload[1]));
      const originalPush = chunk.push.bind(chunk);
      chunk.push = function () {
        for (let i = 0; i < arguments.length; i++) {
          patchModules(arguments[i] && arguments[i][1]);
        }
        return originalPush.apply(this, arguments);
      };
      originalPush([[`interceptify-${Date.now()}`], {}, function (require) {
        try {
          window.__interceptify_webpack_require = require;
          patchRequire(require);
          wrapInStreamExports(require(46849));
        } catch {}
      }]);
    } catch {}
  }

  installWebpackAdProviderHook();

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
          rememberIntel("blockedSegments", {
            srcId: segMatch[1],
            url: url.slice(0, 220),
            reason: "known-ad-source",
          });
          snifferLog("segment-blocked", { srcId: segMatch[1], url: url.slice(0, 220) });
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
          // If we've already classified this srcId as ad, return empty immediately
          if (window.__interceptify_known_ad_sources.has(srcId)) {
            rememberIntel("blockedSources", {
              srcId,
              url: url.slice(0, 220),
              reason: "cached-known-ad-source",
            });
            return Promise.resolve(emptyManifestResponse());
          }
          // Otherwise fetch normally, then inspect & maybe rewrite
          return _f.apply(this, arguments).then(async (resp) => {
            try {
              const text = await resp.clone().text();
              const maxEnd = extractManifestMaxEnd(text);
              if (DEBUG_CAPTURE) {
                rememberIntel("manifests", {
                  srcId,
                  url: url.slice(0, 220),
                  status: resp.status,
                  maxEnd,
                  classifiedAs: maxEnd > 0 && maxEnd < 60000 ? "ad" : "content",
                  bodyLen: text.length,
                  body: text.slice(0, 3000),
                });
                window.__interceptify_meta_log.push({
                  ts: Date.now(),
                  adActive: !!window.__interceptify_ad_active,
                  url: url.slice(0, 220),
                  status: resp.status,
                  bodyLen: text.length,
                  body: text.slice(0, 4000),
                  srcId,
                  maxEnd,
                });
                if (window.__interceptify_meta_log.length > 80)
                  window.__interceptify_meta_log = window.__interceptify_meta_log.slice(-50);
              }
              if (maxEnd > 0 && maxEnd < 60000) {
                window.__interceptify_known_ad_sources.add(srcId);
                rememberIntel("blockedSources", {
                  srcId,
                  url: url.slice(0, 220),
                  maxEnd,
                  reason: "manifest-duration-under-60s",
                });
                snifferLog("manifest-blocked", { srcId, maxEnd, url: url.slice(0, 220) });
                console.log("[interceptify] ad manifest blocked: srcId=" + srcId.slice(0, 8) + "... duration=" + (maxEnd / 1000).toFixed(1) + "s");
                return emptyManifestResponse();
              }
            } catch {}
            return resp;
          });
        }
      } catch {}

      // Observe ad-active CDN segments, but do not block by adActive alone.
      // The same hosts/URL shape carry real music and podcasts; only a
      // classified srcId is safe enough to block.
      try {
        if (window.__interceptify_ad_active &&
            /\/segments\/v\d+\/origins\/[a-f0-9]+\/sources\/[a-f0-9]+\//.test(url) &&
            /spotifycdn\.com/.test(url)) {
          const m = url.match(/\/sources\/([a-f0-9]+)\//);
          snifferLog("segment-ad-active-observed", {
            srcId: m && m[1],
            url: url.slice(0, 220),
          });
        }
      } catch {}

      // Capture interesting JSON bodies (metadata, pathfinder, manifests)
      const interesting =
        /\/metadata\/\d+\/track\//.test(url) ||
        /\/pathfinder\/v\d+\/query/.test(url) ||
        /\/sponsoredplaylist\/v\d+\/sponsored/.test(url) ||
        /\/manifests\/v\d+\/json\/sources\//.test(url);

      const promise = _f.apply(this, arguments);
      if (DEBUG_CAPTURE && interesting) {
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
  if (DEBUG_CAPTURE && XMLHttpRequest && !XMLHttpRequest.prototype.__interceptify_hooked) {
    const _o = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { snifferLog("xhr-open", { method, url: (url || "").slice(0, 220) }); } catch {}
      return _o.apply(this, arguments);
    };
    XMLHttpRequest.prototype.__interceptify_hooked = true;
  }

  // ---- WebSocket constructor wrap (catch the dealer) ----
  if (DEBUG_CAPTURE && window.WebSocket && !window.WebSocket.__interceptify_hooked) {
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
  if (DEBUG_CAPTURE && navigator.sendBeacon && !navigator.sendBeacon.__interceptify_hooked) {
    const _sb = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      try { snifferLog("beacon", { url: (url || "").slice(0, 220) }); } catch {}
      return _sb(url, data);
    };
    navigator.sendBeacon.__interceptify_hooked = true;
  }

  // ---- EventSource (Server-Sent Events) ----
  if (DEBUG_CAPTURE && window.EventSource && !window.EventSource.__interceptify_hooked) {
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
  if (DEBUG_CAPTURE && window.BroadcastChannel && !window.BroadcastChannel.__interceptify_hooked) {
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
  if (DEBUG_CAPTURE && window.MediaSource && !MediaSource.prototype.__interceptify_hooked) {
    const _add = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.__interceptify_hooked = true;
    MediaSource.prototype.addSourceBuffer = function (mime) {
      window.__interceptify_mediasources.add(this);
      try { snifferLog("ms-addSourceBuffer", { mime, msUrl: this.__intercept_url }); } catch {}
      const sb = _add.apply(this, arguments);
      const _ap = sb.appendBuffer.bind(sb);
      sb.appendBuffer = function (data) {
        // Instrument only. Dropping MediaSource buffers can poison the next
        // real track when Spotify leaves ad UI mounted after ad audio ends.
        if (window.__interceptify_ad_active) {
          try { snifferLog("ms-appendBuffer-ad-active", { size: data.byteLength || 0, mime }); } catch {}
        }
        try { snifferLog("ms-appendBuffer", { size: data.byteLength || data.size || 0, mime }); } catch {}
        return _ap(data);
      };
      return sb;
    };
  }

  // URL.createObjectURL: tag MediaSource with its blob URL so we can correlate
  if (DEBUG_CAPTURE && URL.createObjectURL && !URL.createObjectURL.__interceptify_hooked) {
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
      return /interceptify-adblock|nuclearSkip|spamSeekForward|killVideoAd|clickNextTrack|killCurrentMediaSources/.test(s);
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
  if (DEBUG_CAPTURE) setInterval(() => {
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
        knownAdSources: window.__interceptify_known_ad_sources ? window.__interceptify_known_ad_sources.size : 0,
        adIntel: {
          manifests: (window.__interceptify_ad_intel && window.__interceptify_ad_intel.manifests || []).length,
          blockedSources: (window.__interceptify_ad_intel && window.__interceptify_ad_intel.blockedSources || []).length,
          blockedSegments: (window.__interceptify_ad_intel && window.__interceptify_ad_intel.blockedSegments || []).length,
          adPlays: (window.__interceptify_ad_intel && window.__interceptify_ad_intel.adPlays || []).length,
        },
      }));
    } catch {}
  }, 30000);

  // ---- PerformanceObserver: catches EVERY network resource ----
  // Belt-and-braces in case some fetch path bypasses our hooks.
  try {
    if (DEBUG_CAPTURE && typeof PerformanceObserver !== "undefined" && !window.__interceptify_perfobs) {
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
    if (DEBUG_CAPTURE && navigator.serviceWorker && !navigator.serviceWorker.__interceptify_hooked) {
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
    if (DEBUG_CAPTURE && window.Worker && !window.Worker.__interceptify_hooked) {
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
    if (DEBUG_CAPTURE) {
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
    }
  } catch {}

  // ---- Expand metadata-response capture to MORE endpoints ----
  // Add /track-playback/, /play-state/, /audio-url/, /content-feed/ etc.
  // (handled in the fetch hook above via the `interesting` regex; nothing
  // to do here unless we want to add more — current set is good baseline)

  // ---- MutationObserver on <body> to record EXACT ad UI mount time ----
  try {
    if (DEBUG_CAPTURE && !window.__interceptify_mo_installed) {
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
    '[data-testid="ad-countdown-timer"]',
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
    '[data-testid="context-item-info-ad-title"]',
    '[data-testid="context-item-info-ad-subtitle"]',
    '[data-testid="context-item-info"][aria-label*="Advertisement" i]',
    '[data-testid="ad-controls"]',
    '[data-testid="ad-countdown-timer"]',
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
  function markAdEvent(eventName) {
    try {
      if (!eventName || typeof eventName !== "string") return;
      if (AD_START_EVENTS.test(eventName)) {
        eventBasedAd = true;
        log("event-emitter ad signal:", eventName);
      } else if (AD_END_EVENTS.test(eventName)) {
        eventBasedAd = false;
      }
    } catch {}
  }
  function tryHookEmitter(proto, methodName) {
    if (!proto || typeof proto[methodName] !== "function" || proto["__interceptify_" + methodName]) return;
    const orig = proto[methodName];
    proto["__interceptify_" + methodName] = true;
    proto[methodName] = function (eventName, handler, ...rest) {
      try {
        const name = typeof eventName === "string" ? eventName : (eventName && eventName.type);
        if ((methodName === "on" || methodName === "addEventListener") &&
            typeof eventName === "string" && typeof handler === "function" &&
            (AD_START_EVENTS.test(eventName) || AD_END_EVENTS.test(eventName))) {
          const wrapped = function (...args) {
            markAdEvent(eventName);
            return handler.apply(this, args);
          };
          return orig.call(this, eventName, wrapped, ...rest);
        }
        markAdEvent(name);
      } catch {}
      return orig.call(this, eventName, handler, ...rest);
    };
  }
  // We don't know the exact emitter class, so probe a few likely candidates
  // late (after Spotify has booted its module graph).
  setInterval(() => {
    try {
      tryHookEmitter(EventTarget && EventTarget.prototype, "dispatchEvent");
      tryHookEmitter(EventTarget && EventTarget.prototype, "addEventListener");
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
    // 4) Spotify's own in-stream ad provider returned an ad object before
    //    React painted the ad controls. Use it as a short bridge signal;
    //    once the DOM mounts, selector detection above takes over.
    if (window.__interceptify_instream_ad_until &&
        Date.now() < window.__interceptify_instream_ad_until) {
      return "instream-ad-object";
    }
    // 5) Now-playing title says Advertisement
    const titleEl = document.querySelector('[data-testid="context-item-link"]');
    if (titleEl && /advert/i.test(titleEl.textContent || "")) return "title-text:advert";
    // 6) <title> === "Spotify" with playing audio shorter than 60s -> very
    //    likely an ad. Music titles always include the track name.
    if (document.title.replace(/^●\s*/, "").trim() === "Spotify") {
      const a = document.querySelector("audio");
      if (a && isFinite(a.duration) && a.duration > 0 && a.duration < 65 && !a.paused) {
        return "heuristic:short-audio-no-title";
      }
    }
    return null;
  }

  function captureAdPlay(reason) {
    if (!DEBUG_CAPTURE) return;
    try {
      const testIds = [];
      document.querySelectorAll("[data-testid]").forEach((e) => {
        const id = e.getAttribute("data-testid");
        if (id && /ad|promo|sponsor|advert/i.test(id)) testIds.push(id);
      });
      const recentNetwork = (window.__interceptify_sniffer || [])
        .filter((e) => Date.now() - e.ts < 30000)
        .filter((e) => /fetch|xhr-open|perf-resource|segment|manifest/.test(e.kind || ""))
        .slice(-80);
      rememberIntel("adPlays", {
        reason,
        testIds: Array.from(new Set(testIds)).slice(0, 80),
        knownAdSources: Array.from(window.__interceptify_known_ad_sources || []),
        recentNetwork,
      });
    } catch {}
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

  // Respect user pause during ads. Earlier builds forced play so seek spam
  // could drain the ad, but that made the pause button feel broken.
  function forcePlayDuringAd() {
    return false;
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
    // 3. Do not force-play if paused. The user can pause during an ad.
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
    // 7. Force-mute every <audio> element. Do not dispatch ended here:
    // if ad detection lingers, that can kill the first real song after it.
    document.querySelectorAll("audio").forEach((a) => {
      try { a.muted = true; a.volume = 0; } catch {}
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
        captureAdPlay(detected);
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
      if (detected !== "instream-ad-object") {
        nuclearSkip();
      }
      // Avoid endOfStream() here; Spotify can reuse the same MediaSource
      // across the ad-to-song transition, which can stall the next track.
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
    version: "2026-04-30",
    debugCapture: DEBUG_CAPTURE,
    stats: () => ({ ...stats }),
    status() { console.table(stats); return stats; },
    knownAdSources() {
      return Array.from(window.__interceptify_known_ad_sources || []);
    },
    adIntel() {
      return {
        ...(window.__interceptify_ad_intel || {}),
        knownAdSources: Array.from(window.__interceptify_known_ad_sources || []),
      };
    },
    lastAdPlay() {
      const plays = window.__interceptify_ad_intel && window.__interceptify_ad_intel.adPlays || [];
      return plays[plays.length - 1] || null;
    },
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
