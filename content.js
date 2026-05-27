/*
 * Focus Shield — Content Script v3.1
 *
 * Block model: show a full-page overlay on blocked surfaces. No auto-redirect.
 * Navigation to an allowed reference page only happens when the user clicks
 * the "Go to <reference>" button on the block screen.
 *
 * Platforms: X/Twitter, YouTube, Instagram.
 *
 * SPA handling: wraps pushState/replaceState, listens to popstate,
 * yt-navigate-finish, and polls URL every 1s as fallback.
 *
 * Overlay guard: MutationObserver re-injects the overlay if the page removes it.
 */

(function () {
  "use strict";

  if (window.__focusShieldLoaded) return;
  window.__focusShieldLoaded = true;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[Focus Shield]", ...a);

  log("Content script loaded on", location.hostname, location.pathname);

  // ── Storage defaults ──────────────────────────────────────────

  const DEFAULTS = {
    focusEnabled: true,
    sessionActive: false,
    dailyLimitMinutes: 30,
    remainingSeconds: 1800,
    lastResetDate: "",
    sessionStartedAt: null,
  };

  // ── URL Classifier ────────────────────────────────────────────
  //
  // Returns:
  //   { platform, surface: "allowed"|"blocked"|"neutral",
  //     reason, allowedReferenceUrl, allowedReferenceLabel }
  //
  // No redirectUrl field — the overlay buttons handle navigation.

  function classifyUrl(urlStr) {
    let url;
    try { url = new URL(urlStr); } catch {
      return { platform: "other", surface: "neutral", reason: "invalid url" };
    }

    const host = url.hostname.replace(/^(www\.|mobile\.)/, "");
    const path = url.pathname;

    // ── X / Twitter ────────────────────────────────────────────
    if (host === "x.com" || host === "twitter.com") {
      const ref = { allowedReferenceUrl: "https://x.com/i/bookmarks", allowedReferenceLabel: "Bookmarks" };

      // Always allow
      if (path.startsWith("/i/bookmarks"))       return { platform:"x", surface:"allowed", reason:"bookmarks", ...ref };
      if (path.startsWith("/compose"))            return { platform:"x", surface:"allowed", reason:"compose", ...ref };
      if (path.startsWith("/intent/tweet"))       return { platform:"x", surface:"allowed", reason:"intent", ...ref };
      if (path.startsWith("/messages"))           return { platform:"x", surface:"allowed", reason:"messages", ...ref };
      if (/^\/[^/]+\/status\/\d+/.test(path))    return { platform:"x", surface:"allowed", reason:"status page", ...ref };

      // Block
      if (path === "/" || path === "")            return { platform:"x", surface:"blocked", reason:"home feed", ...ref };
      if (path.startsWith("/home"))               return { platform:"x", surface:"blocked", reason:"home feed", ...ref };
      if (path.startsWith("/explore"))            return { platform:"x", surface:"blocked", reason:"explore", ...ref };
      if (path.startsWith("/notifications"))      return { platform:"x", surface:"blocked", reason:"notifications", ...ref };
      if (path.startsWith("/search"))             return { platform:"x", surface:"blocked", reason:"search", ...ref };

      // Profile pages and everything else — neutral (allow)
      return { platform:"x", surface:"neutral", reason:"profile or other", ...ref };
    }

    // ── YouTube ────────────────────────────────────────────────
    if (host === "youtube.com" || host === "studio.youtube.com") {
      const ref = { allowedReferenceUrl: "https://www.youtube.com/feed/history", allowedReferenceLabel: "History" };

      if (host === "studio.youtube.com")           return { platform:"youtube", surface:"allowed", reason:"studio", ...ref };

      // Always allow
      if (path.startsWith("/watch"))               return { platform:"youtube", surface:"allowed", reason:"watch", ...ref };
      if (path.startsWith("/feed/history"))        return { platform:"youtube", surface:"allowed", reason:"history", ...ref };
      if (path.startsWith("/playlist"))            return { platform:"youtube", surface:"allowed", reason:"playlist", ...ref };
      if (path.startsWith("/upload"))              return { platform:"youtube", surface:"allowed", reason:"upload", ...ref };
      if (path.startsWith("/create"))              return { platform:"youtube", surface:"allowed", reason:"create", ...ref };

      // Block
      if (path === "/" || path === "")             return { platform:"youtube", surface:"blocked", reason:"home feed", ...ref };
      if (path.startsWith("/feed/subscriptions"))  return { platform:"youtube", surface:"blocked", reason:"subscriptions", ...ref };
      if (path.startsWith("/feed/trending"))       return { platform:"youtube", surface:"blocked", reason:"trending", ...ref };
      if (path.startsWith("/feed/explore"))        return { platform:"youtube", surface:"blocked", reason:"explore", ...ref };
      if (path.startsWith("/shorts"))              return { platform:"youtube", surface:"blocked", reason:"shorts", ...ref };
      if (path.startsWith("/results"))             return { platform:"youtube", surface:"blocked", reason:"search results", ...ref };
      if (path.startsWith("/gaming"))              return { platform:"youtube", surface:"blocked", reason:"gaming", ...ref };
      if (path.startsWith("/trending"))            return { platform:"youtube", surface:"blocked", reason:"trending", ...ref };

      return { platform:"youtube", surface:"neutral", reason:"other youtube page", ...ref };
    }

    // ── Instagram ──────────────────────────────────────────────
    if (host === "instagram.com") {
      const ref = { allowedReferenceUrl: "https://www.instagram.com/direct/inbox/", allowedReferenceLabel: "Direct Messages" };

      // Always allow
      if (path.startsWith("/direct/inbox"))        return { platform:"instagram", surface:"allowed", reason:"direct messages", ...ref };
      if (path.startsWith("/accounts"))            return { platform:"instagram", surface:"allowed", reason:"account settings", ...ref };
      if (/^\/p\//.test(path))                     return { platform:"instagram", surface:"allowed", reason:"individual post", ...ref };

      // Block
      if (path === "/" || path === "")             return { platform:"instagram", surface:"blocked", reason:"home feed", ...ref };
      if (path.startsWith("/explore"))             return { platform:"instagram", surface:"blocked", reason:"explore", ...ref };
      if (path.startsWith("/reels"))               return { platform:"instagram", surface:"blocked", reason:"reels", ...ref };
      if (path.startsWith("/stories"))             return { platform:"instagram", surface:"blocked", reason:"stories", ...ref };

      // Profile pages — neutral (allow)
      return { platform:"instagram", surface:"neutral", reason:"profile or other", ...ref };
    }

    return { platform: "other", surface: "neutral", reason: "untracked platform" };
  }

  // ── State helpers ─────────────────────────────────────────────

  let _state = null;

  function calcRemaining(state) {
    if (!state.sessionActive || !state.sessionStartedAt) return state.remainingSeconds;
    const elapsed = Math.floor((Date.now() - state.sessionStartedAt) / 1000);
    return Math.max(0, state.remainingSeconds - elapsed);
  }

  function isSessionLive(state) {
    return state.sessionActive && calcRemaining(state) > 0;
  }

  function fmt(secs) {
    const m = Math.floor(secs / 60);
    return `${m}:${String(secs % 60).padStart(2, "0")}`;
  }

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
      log("Storage unavailable:", e.message);
      callback({ ...DEFAULTS });
    }
  }

  // ── Block screen overlay ──────────────────────────────────────

  let _overlayShown = false;
  let _overlayGuard = null;
  let _currentClassification = null;

  const PLATFORM_LABELS = {
    x: "X / Twitter",
    youtube: "YouTube",
    instagram: "Instagram",
  };

  function buildOverlayCard(cl, state) {
    const remaining = calcRemaining(state);
    const expired = remaining <= 0;
    const platformLabel = PLATFORM_LABELS[cl.platform] || "This site";
    const refLabel = cl.allowedReferenceLabel || "Reference";

    return `
<div id="fs-overlay-card" style="
  text-align:center;max-width:400px;width:90%;
  padding:44px 32px;
  background:#111118;
  border:1px solid rgba(255,255,255,.08);
  border-radius:20px;
  box-shadow:0 24px 80px rgba(0,0,0,.7);
">
  <div style="font-size:44px;margin-bottom:14px;line-height:1">🛡️</div>
  <h1 style="font-size:20px;font-weight:800;margin:0 0 4px;letter-spacing:-.3px;color:#e7e9ea">Focus Shield</h1>
  <p style="font-size:11px;color:#536471;margin:0 0 20px;font-weight:700;letter-spacing:.8px;text-transform:uppercase">${platformLabel}</p>
  <p style="font-size:14px;color:#8b8fa8;line-height:1.6;margin:0 0 6px">
    This feed is blocked while Focus Shield is active.
  </p>
  <p id="fs-overlay-time" style="font-size:13px;color:#536471;margin:0 0 26px">
    ${expired
      ? "Daily budget exhausted — resets at midnight."
      : `<strong style="color:#e7e9ea">${fmt(remaining)}</strong> remaining in today's budget.`
    }
  </p>
  <div style="display:flex;flex-direction:column;gap:9px;margin-bottom:20px">
    ${!expired ? `
    <button id="fs-btn-start" style="
      display:block;width:100%;padding:13px 20px;
      border-radius:9999px;border:none;
      background:#4ade80;color:#000;
      font-size:14px;font-weight:700;cursor:pointer;
      font-family:inherit;
    ">▶ Start free-scrolling session</button>` : ""}
    <button id="fs-btn-reference" style="
      display:block;width:100%;padding:11px 20px;
      border-radius:9999px;border:none;
      background:rgba(255,255,255,.07);color:#aab4be;
      font-size:13px;font-weight:600;cursor:pointer;
      font-family:inherit;
    ">Go to ${refLabel}</button>
  </div>
  <p style="font-size:11px;color:#3d444b;line-height:1.5;margin:0">
    Creation and reference surfaces are still available.
  </p>
</div>
    `.trim();
  }

  function showBlockScreen(cl, state) {
    // Re-use or create the overlay container
    let ov = document.getElementById("focus-shield-overlay");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "focus-shield-overlay";
      // Attach to <html> — survives body replacements
      document.documentElement.appendChild(ov);
    }

    // Styles on the overlay element itself
    const s = ov.style;
    s.cssText = [
      "position:fixed", "inset:0", "z-index:2147483647",
      "background:#0a0a0f",
      "display:flex", "align-items:center", "justify-content:center",
      "overflow:auto",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      "color:#e7e9ea",
    ].join(";");

    ov.innerHTML = buildOverlayCard(cl, state);
    _overlayShown = true;
    _currentClassification = cl;

    log("Block screen shown:", cl.platform, `(${cl.reason})`);

    // Wire start-session button
    const startBtn = document.getElementById("fs-btn-start");
    if (startBtn) {
      startBtn.onmouseover = () => { startBtn.style.background = "#22c55e"; };
      startBtn.onmouseout  = () => { startBtn.style.background = "#4ade80"; };
      startBtn.onclick = () => {
        startBtn.disabled = true;
        startBtn.textContent = "Starting…";
        chrome.runtime.sendMessage({ type: "START_SESSION" }, (res) => {
          if (res && res.success) {
            log("Session started — removing block screen");
            hideBlockScreen();
            loadState(s => { _state = s; });
          } else {
            startBtn.textContent = "▶ Start free-scrolling session";
            startBtn.disabled = false;
            log("START_SESSION failed:", res);
          }
        });
      };
    }

    // Wire reference button
    const refBtn = document.getElementById("fs-btn-reference");
    if (refBtn) {
      refBtn.onmouseover = () => { refBtn.style.background = "rgba(255,255,255,.13)"; };
      refBtn.onmouseout  = () => { refBtn.style.background = "rgba(255,255,255,.07)"; };
      refBtn.onclick = () => {
        if (cl.allowedReferenceUrl) {
          log("Navigating to reference:", cl.allowedReferenceUrl);
          location.href = cl.allowedReferenceUrl;
        }
      };
    }

    // Guard: re-inject if the page removes our overlay
    startOverlayGuard(cl, state);
  }

  function hideBlockScreen() {
    const ov = document.getElementById("focus-shield-overlay");
    if (ov) ov.remove();
    _overlayShown = false;
    _currentClassification = null;
    stopOverlayGuard();
    log("Block screen hidden");
  }

  // Re-inject the overlay if the page removes it (Instagram / YouTube do this)
  function startOverlayGuard(cl, state) {
    stopOverlayGuard();
    _overlayGuard = new MutationObserver(() => {
      if (_overlayShown && !document.getElementById("focus-shield-overlay")) {
        log("Overlay removed by page — re-injecting");
        // Re-fetch state so remaining time is accurate
        loadState(fresh => {
          if (_overlayShown) showBlockScreen(cl, fresh);
        });
      }
    });
    _overlayGuard.observe(document.documentElement, { childList: true });
  }

  function stopOverlayGuard() {
    if (_overlayGuard) { _overlayGuard.disconnect(); _overlayGuard = null; }
  }

  // Live-update remaining time in the overlay (without re-rendering the whole card)
  setInterval(() => {
    if (!_overlayShown || !_state) return;
    const timeEl = document.getElementById("fs-overlay-time");
    if (!timeEl) return;
    const rem = calcRemaining(_state);
    const expired = rem <= 0;
    timeEl.innerHTML = expired
      ? "Daily budget exhausted — resets at midnight."
      : `<strong style="color:#e7e9ea">${fmt(rem)}</strong> remaining in today's budget.`;

    // If the budget just ran out, re-render the whole card (removes Start button)
    if (expired && document.getElementById("fs-btn-start")) {
      loadState(s => {
        _state = s;
        if (_currentClassification) showBlockScreen(_currentClassification, s);
      });
    }
  }, 1000);

  // ── Core enforcement ──────────────────────────────────────────

  function enforce(state) {
    const cl = classifyUrl(location.href);
    log(
      "Enforce | URL:", location.href,
      "| surface:", cl.surface, `(${cl.reason})`,
      "| focusEnabled:", state.focusEnabled,
      "| sessionActive:", state.sessionActive,
      "| remaining:", calcRemaining(state) + "s"
    );

    if (!state.focusEnabled) {
      log("Shield disabled — allowing all");
      hideBlockScreen();
      return;
    }

    if (isSessionLive(state)) {
      log("Session active — allowing");
      hideBlockScreen();
      return;
    }

    if (cl.surface === "blocked") {
      showBlockScreen(cl, state);
    } else {
      hideBlockScreen();
    }
  }

  // ── SPA navigation hooks ──────────────────────────────────────

  let _debounce = null;

  function scheduleEnforce() {
    clearTimeout(_debounce);
    _debounce = setTimeout(() => {
      loadState(s => { _state = s; enforce(s); });
    }, 120);
  }

  function hookNavigation() {
    const wrap = (fn) => function (...args) {
      const r = fn.apply(this, args);
      scheduleEnforce();
      return r;
    };
    history.pushState    = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener("popstate",          scheduleEnforce);
    window.addEventListener("yt-navigate-finish", scheduleEnforce); // YouTube SPA
  }

  // ── Storage + message listeners ───────────────────────────────

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!_state) return;
    for (const [k, { newValue }] of Object.entries(changes)) _state[k] = newValue;
    log("Storage changed — re-enforcing");
    enforce(_state);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "STATE_UPDATE") {
      loadState(s => { _state = s; enforce(s); });
    }
  });

  // ── URL polling (SPA fallback) ────────────────────────────────

  let _lastHref = location.href;
  setInterval(() => {
    if (location.href !== _lastHref) {
      _lastHref = location.href;
      log("URL changed →", _lastHref);
      scheduleEnforce();
    }
  }, 1000);

  // ── Timer pill (shown during active session) ──────────────────

  function ensurePillStyles() {
    if (document.getElementById("fs-pill-styles")) return;
    const s = document.createElement("style");
    s.id = "fs-pill-styles";
    s.textContent = `
#fs-pill{position:fixed;top:12px;right:12px;z-index:2147483646;display:flex;align-items:center;
gap:8px;background:rgba(10,10,14,.9);backdrop-filter:blur(12px);padding:6px 12px;
border-radius:20px;border:1px solid rgba(255,255,255,.1);box-shadow:0 4px 16px rgba(0,0,0,.4);
font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#e7e9ea;user-select:none}
#fs-pill-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.fsd-active{background:#4ade80;animation:fsp 1.5s ease-in-out infinite}
.fsd-idle{background:#71767b}.fsd-expired{background:#f4212e}
@keyframes fsp{0%,100%{opacity:1}50%{opacity:.4}}
#fs-pill-time{font-variant-numeric:tabular-nums;font-weight:600;min-width:38px}
#fs-pill-stop{padding:3px 10px;border-radius:12px;border:none;cursor:pointer;background:rgba(255,255,255,.1);
color:#e7e9ea;font-size:11px;font-weight:700;font-family:inherit}
#fs-pill-stop:hover{background:rgba(255,255,255,.18)}
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  function updatePill(state) {
    if (!document.body || _overlayShown) return; // hide pill when block screen is up

    ensurePillStyles();
    let pill = document.getElementById("fs-pill");
    const live = isSessionLive(state);
    const remaining = calcRemaining(state);

    if (!live) {
      if (pill) pill.remove();
      return;
    }

    if (!pill) {
      pill = document.createElement("div");
      pill.id = "fs-pill";
      pill.innerHTML = `<div id="fs-pill-dot" class="fsd-active"></div><span id="fs-pill-time">--:--</span><button id="fs-pill-stop">Stop</button>`;
      document.documentElement.appendChild(pill);
      document.getElementById("fs-pill-stop").onclick = () => {
        chrome.runtime.sendMessage({ type: "STOP_SESSION" }, () => {
          loadState(s => { _state = s; updatePill(s); enforce(s); });
        });
      };
    }

    const timeEl = document.getElementById("fs-pill-time");
    if (timeEl) timeEl.textContent = fmt(remaining);
  }

  setInterval(() => {
    if (_state) updatePill(_state);
  }, 1000);

  // ── Init ──────────────────────────────────────────────────────

  function init() {
    hookNavigation();
    loadState(state => {
      _state = state;
      log("Initial state:", JSON.stringify({
        focusEnabled: state.focusEnabled,
        sessionActive: state.sessionActive,
        remainingSeconds: calcRemaining(state),
      }));
      enforce(state);
    });
  }

  init();

})();
