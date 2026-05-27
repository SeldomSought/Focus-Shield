/*
 * Focus Shield — Content Script v3
 *
 * Runs at document_start on X/Twitter and YouTube.
 * Reads state directly from chrome.storage.local (no service worker messaging required).
 * Redirects blocked URLs immediately. Hooks SPA navigation to recheck on route changes.
 */

(function () {
  "use strict";

  if (window.__focusShieldLoaded) return;
  window.__focusShieldLoaded = true;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[FS CS]", ...a);

  // ── Storage defaults (must match background.js) ───────────────

  const DEFAULTS = {
    focusEnabled: true,
    sessionActive: false,
    dailyLimitMinutes: 30,
    remainingSeconds: 1800,
    lastResetDate: "",
    sessionStartedAt: null,
  };

  // ── URL Classifier (mirrored from background.js) ──────────────

  function classifyUrl(urlStr) {
    let url;
    try { url = new URL(urlStr); } catch {
      return { platform: "other", surface: "neutral", reason: "invalid url" };
    }

    const host = url.hostname.replace(/^(www\.|mobile\.)/, "");
    const path = url.pathname;

    // ── X / Twitter ──
    if (host === "x.com" || host === "twitter.com") {
      const redirect = "https://x.com/i/bookmarks";

      if (path.startsWith("/i/bookmarks"))       return { platform:"x", surface:"allowed", reason:"bookmarks" };
      if (path.startsWith("/compose"))            return { platform:"x", surface:"allowed", reason:"compose" };
      if (path.startsWith("/intent/tweet"))       return { platform:"x", surface:"allowed", reason:"intent" };
      if (path.startsWith("/messages"))           return { platform:"x", surface:"allowed", reason:"messages" };
      if (/^\/[^/]+\/status\/\d+/.test(path))    return { platform:"x", surface:"allowed", reason:"status page" };

      if (path === "/" || path === "")            return { platform:"x", surface:"blocked", redirectUrl:redirect, reason:"root feed" };
      if (path.startsWith("/home"))               return { platform:"x", surface:"blocked", redirectUrl:redirect, reason:"home feed" };
      if (path.startsWith("/explore"))            return { platform:"x", surface:"blocked", redirectUrl:redirect, reason:"explore" };
      if (path.startsWith("/notifications"))      return { platform:"x", surface:"blocked", redirectUrl:redirect, reason:"notifications" };
      if (path.startsWith("/search"))             return { platform:"x", surface:"blocked", redirectUrl:redirect, reason:"search" };

      return { platform:"x", surface:"neutral", reason:"other x page" };
    }

    // ── YouTube ──
    if (host === "youtube.com") {
      const redirect = "https://www.youtube.com/feed/history";

      if (path.startsWith("/watch"))              return { platform:"youtube", surface:"allowed", reason:"watch" };
      if (path.startsWith("/feed/history"))       return { platform:"youtube", surface:"allowed", reason:"history" };
      if (path.startsWith("/playlist"))           return { platform:"youtube", surface:"allowed", reason:"playlist" };
      if (path.startsWith("/upload"))             return { platform:"youtube", surface:"allowed", reason:"upload" };
      if (path.startsWith("/create"))             return { platform:"youtube", surface:"allowed", reason:"create" };

      if (path === "/" || path === "")            return { platform:"youtube", surface:"blocked", redirectUrl:redirect, reason:"home feed" };
      if (path.startsWith("/feed/subscriptions")) return { platform:"youtube", surface:"blocked", redirectUrl:redirect, reason:"subscriptions" };
      if (path.startsWith("/feed/trending"))      return { platform:"youtube", surface:"blocked", redirectUrl:redirect, reason:"trending" };
      if (path.startsWith("/feed/explore"))       return { platform:"youtube", surface:"blocked", redirectUrl:redirect, reason:"explore" };
      if (path.startsWith("/shorts"))             return { platform:"youtube", surface:"blocked", redirectUrl:redirect, reason:"shorts" };
      if (path.startsWith("/results"))            return { platform:"youtube", surface:"blocked", redirectUrl:redirect, reason:"search results" };

      return { platform:"youtube", surface:"neutral", reason:"other youtube page" };
    }

    return { platform:"other", surface:"neutral", reason:"untracked platform" };
  }

  // ── State ─────────────────────────────────────────────────────

  let _state = null;

  function calcRemaining(state) {
    if (!state.sessionActive || !state.sessionStartedAt) return state.remainingSeconds;
    const elapsed = Math.floor((Date.now() - state.sessionStartedAt) / 1000);
    return Math.max(0, state.remainingSeconds - elapsed);
  }

  function isSessionLive(state) {
    if (!state.sessionActive) return false;
    return calcRemaining(state) > 0;
  }

  // ── Load state from storage directly (fast, no SW messaging) ──

  function loadState(callback) {
    try {
      chrome.storage.local.get(null, (data) => {
        if (chrome.runtime.lastError) {
          log("Storage read error:", chrome.runtime.lastError.message);
          callback({ ...DEFAULTS });
          return;
        }
        callback({ ...DEFAULTS, ...data });
      });
    } catch (e) {
      log("Storage unavailable:", e);
      callback({ ...DEFAULTS });
    }
  }

  // ── Core enforcement ──────────────────────────────────────────

  let _redirecting = false;

  function enforce(state) {
    if (_redirecting) return;

    if (!state.focusEnabled) {
      log("Shield disabled — allow all");
      return;
    }

    if (isSessionLive(state)) {
      log("Session active — allow. Remaining:", calcRemaining(state), "s");
      return;
    }

    const { surface, redirectUrl, reason } = classifyUrl(location.href);
    log("Enforce:", surface, `(${reason})`, location.href);

    if (surface === "blocked" && redirectUrl) {
      // Don't redirect if we're already at the redirect destination
      if (location.href === redirectUrl || location.href.startsWith(redirectUrl)) {
        log("Already at redirect target, skip");
        return;
      }
      log("Redirecting → ", redirectUrl);
      _redirecting = true;
      location.replace(redirectUrl);
    }
  }

  // ── SPA navigation hooks ──────────────────────────────────────

  function hookNavigation() {
    const wrap = (original) => function (...args) {
      const result = original.apply(this, args);
      setTimeout(() => {
        _redirecting = false; // reset guard after navigation settles
        loadState(enforce);
      }, 100);
      return result;
    };

    history.pushState    = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);

    window.addEventListener("popstate", () => {
      _redirecting = false;
      setTimeout(() => loadState(enforce), 100);
    });

    // YouTube fires this event on every internal navigation
    window.addEventListener("yt-navigate-finish", () => {
      _redirecting = false;
      setTimeout(() => loadState(enforce), 150);
    });
  }

  // ── Storage change listener (responds to background state changes) ──

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!_state) return;
    // Update local state cache with changed values
    for (const [key, { newValue }] of Object.entries(changes)) {
      _state[key] = newValue;
    }
    log("Storage changed, re-enforcing");
    _redirecting = false;
    enforce(_state);
  });

  // ── Background message listener (for immediate enforcement triggers) ──

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "STATE_UPDATE") {
      _redirecting = false;
      loadState(s => { _state = s; enforce(s); });
    }
  });

  // ── URL polling (fallback for SPAs that don't fire events) ────

  let _lastHref = location.href;
  setInterval(() => {
    if (location.href !== _lastHref) {
      _lastHref = location.href;
      log("URL poll detected change:", _lastHref);
      _redirecting = false;
      loadState(enforce);
    }
  }, 1000);

  // ── Timer pill UI ─────────────────────────────────────────────

  function injectPillStyles() {
    if (document.getElementById("fs-pill-styles")) return;
    const s = document.createElement("style");
    s.id = "fs-pill-styles";
    s.textContent = `
#fs-pill{position:fixed;top:12px;right:12px;z-index:2147483647;display:flex;align-items:center;gap:8px;
background:rgba(10,10,14,.9);backdrop-filter:blur(12px);padding:6px 12px;border-radius:20px;
border:1px solid rgba(255,255,255,.1);box-shadow:0 4px 16px rgba(0,0,0,.4);
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;color:#e7e9ea;
user-select:none;cursor:default}
#fs-pill-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.fs-dot-active{background:#4ade80;animation:fs-pulse 1.5s ease-in-out infinite}
.fs-dot-idle{background:#71767b}
.fs-dot-expired{background:#f4212e}
@keyframes fs-pulse{0%,100%{opacity:1}50%{opacity:.4}}
#fs-pill-time{font-variant-numeric:tabular-nums;font-weight:600;min-width:38px}
#fs-pill-btn{padding:3px 10px;border-radius:12px;border:none;cursor:pointer;
font-size:11px;font-weight:700;transition:background .15s}
.fs-btn-start{background:#4ade80;color:#000}
.fs-btn-start:hover{background:#22c55e}
.fs-btn-stop{background:rgba(255,255,255,.1);color:#e7e9ea}
.fs-btn-stop:hover{background:rgba(255,255,255,.15)}
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  function ensurePill() {
    if (document.getElementById("fs-pill")) return;
    const el = document.createElement("div");
    el.id = "fs-pill";
    el.innerHTML = `<div id="fs-pill-dot" class="fs-dot-idle"></div><span id="fs-pill-time">30:00</span><button id="fs-pill-btn" class="fs-btn-start">Start</button>`;
    document.documentElement.appendChild(el);

    document.getElementById("fs-pill-btn").addEventListener("click", () => {
      const btn = document.getElementById("fs-pill-btn");
      if (btn.classList.contains("fs-btn-start")) {
        chrome.runtime.sendMessage({ type: "START_SESSION" }, () => {
          loadState(s => { _state = s; updatePill(s); enforce(s); });
        });
      } else {
        chrome.runtime.sendMessage({ type: "STOP_SESSION" }, () => {
          loadState(s => { _state = s; updatePill(s); enforce(s); });
        });
      }
    });
  }

  function fmt(s) {
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  }

  function updatePill(state) {
    if (!document.body) return; // too early

    injectPillStyles();
    ensurePill();

    const remaining = calcRemaining(state);
    const live = isSessionLive(state);
    const expired = remaining <= 0;

    const dot  = document.getElementById("fs-pill-dot");
    const time = document.getElementById("fs-pill-time");
    const btn  = document.getElementById("fs-pill-btn");

    if (!dot || !time || !btn) return;

    time.textContent = fmt(remaining);
    dot.className = expired ? "fs-dot-expired" : live ? "fs-dot-active" : "fs-dot-idle";

    if (live) {
      btn.textContent = "Stop";
      btn.className = "fs-btn-stop";
    } else {
      btn.textContent = expired ? "—" : "Start";
      btn.className = "fs-btn-start";
      btn.disabled = expired;
    }
  }

  // Update pill every second when visible
  setInterval(() => {
    if (_state && document.body) updatePill(_state);
  }, 1000);

  // ── Init ──────────────────────────────────────────────────────

  function init() {
    hookNavigation();
    loadState(state => {
      _state = state;
      log("Initial state:", state);
      enforce(state);
      // Pill can only be injected once body exists
      if (document.body) {
        updatePill(state);
      } else {
        document.addEventListener("DOMContentLoaded", () => updatePill(_state), { once: true });
      }
    });
  }

  init();

})();
