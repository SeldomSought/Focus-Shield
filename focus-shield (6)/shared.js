/*
 * Focus Shield — Shared Content Script (v5)
 *
 * ACTIVE SESSION: Timer pill. Zero interference. Page reload on unlock.
 *
 * LOCKED: Platform decides what happens via FocusShield.onLocked(pageType):
 *   - Default: overlay on feed, redirect on blocked, nothing on allowed
 *   - Instagram overrides: redirect-based (no overlay — so nav stays usable)
 *
 * OVERLAY STABILITY:
 *   - Overlay only rebuilds when URL changes or expired state toggles
 *   - Timer ticks update the pill only, never touch the overlay
 *   - All evaluation is debounced with 500ms settle time
 */

(function () {
  "use strict";

  if (window.__focusShieldLoaded) return;
  window.__focusShieldLoaded = true;

  window.FocusShield = {
    platform: null,
    isAllowedPage: () => true,
    isFeedPage: () => false,
    isBlockedPage: () => false,
    getAllowedLinks: () => [],
    getSavedUrl: () => "/",
    // Platform can override this to customize lock behavior
    // Return true to indicate it handled the lock (skip default overlay)
    onLocked: null,
  };

  let _lastFeedUnlocked = null;
  let _urlWatcher = null;
  let _currentTimer = null;
  let _overlayUrl = null;      // URL for which overlay is currently shown
  let _overlayExpired = null;  // expired state when overlay was built
  let _evalDebounce = null;
  let _lastEvalUrl = null;

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════

  function getState() {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: "GET_STATE" }, r => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(r);
        });
      } catch { resolve(null); }
    });
  }

  function fmt(s) {
    const m = Math.floor(s / 60);
    return `${m}:${(s % 60).toString().padStart(2, "0")}`;
  }

  function send(type) {
    chrome.runtime.sendMessage({ type }, r => {
      if (r?.success) updateUI(r.timer);
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // TIMER PILL
  // ═══════════════════════════════════════════════════════════════

  function ensureTimerPill() {
    if (document.getElementById("fs-timer-overlay")) return;
    const el = document.createElement("div");
    el.id = "fs-timer-overlay";
    el.innerHTML = `
      <div id="fs-timer-pill">
        <div id="fs-timer-dot"></div>
        <span id="fs-timer-display">30:00</span>
        <div id="fs-timer-controls">
          <button id="fs-btn-start" class="fs-btn fs-btn-start" title="Start">▶</button>
          <button id="fs-btn-pause" class="fs-btn fs-btn-pause" title="Pause" style="display:none">❚❚</button>
          <button id="fs-btn-stop" class="fs-btn fs-btn-stop" title="Stop" style="display:none">■</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    document.getElementById("fs-btn-start").addEventListener("click", () => send("START_SESSION"));
    document.getElementById("fs-btn-pause").addEventListener("click", () => send("PAUSE_SESSION"));
    document.getElementById("fs-btn-stop").addEventListener("click", () => send("STOP_SESSION"));
  }

  // ═══════════════════════════════════════════════════════════════
  // LOCK OVERLAY — only rebuilt on URL change or expired toggle
  // ═══════════════════════════════════════════════════════════════

  function showOverlay(isExpired, remaining) {
    const currentUrl = window.location.pathname;

    // Skip rebuild if already showing for this URL + expired state
    if (_overlayUrl === currentUrl && _overlayExpired === isExpired) {
      // Just make sure it's visible
      const ov = document.getElementById("fs-lock-overlay");
      if (ov) ov.style.display = "flex";
      return;
    }

    _overlayUrl = currentUrl;
    _overlayExpired = isExpired;

    let ov = document.getElementById("fs-lock-overlay");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "fs-lock-overlay";
      document.body.appendChild(ov);
    }
    ov.style.display = "flex";

    const links = (window.FocusShield.getAllowedLinks() || []);
    const linkHtml = links.map((l, i) =>
      `<button class="fs-lock-link" id="fs-nav-${i}">${l.icon} ${l.label}</button>`
    ).join("");

    if (isExpired) {
      ov.innerHTML = `<div class="fs-lock-card">
        <div class="fs-lock-icon">🛑</div>
        <h2 class="fs-lock-title">Daily Limit Reached</h2>
        <p class="fs-lock-text">Resets at midnight.</p>
        ${linkHtml ? `<div class="fs-lock-links">${linkHtml}</div>` : ""}
      </div>`;
    } else {
      ov.innerHTML = `<div class="fs-lock-card">
        <div class="fs-lock-icon">🔒</div>
        <h2 class="fs-lock-title">Feed Locked</h2>
        <p class="fs-lock-text">You have <strong>${fmt(remaining)}</strong> remaining today.</p>
        <button id="fs-lock-start-btn" class="fs-lock-btn">▶ Start Session</button>
        <p class="fs-lock-subtext">Bookmarks &amp; posting always free.</p>
        ${linkHtml ? `<div class="fs-lock-links">${linkHtml}</div>` : ""}
      </div>`;
    }

    // Attach handlers after DOM update
    requestAnimationFrame(() => {
      const startBtn = document.getElementById("fs-lock-start-btn");
      if (startBtn) startBtn.onclick = () => send("START_SESSION");

      links.forEach((l, i) => {
        const btn = document.getElementById(`fs-nav-${i}`);
        if (btn) btn.onclick = () => { window.location.href = l.url; };
      });
    });
  }

  function hideOverlay() {
    _overlayUrl = null;
    _overlayExpired = null;
    const ov = document.getElementById("fs-lock-overlay");
    if (ov) ov.style.display = "none";
  }

  // ═══════════════════════════════════════════════════════════════
  // PAGE EVALUATION — only runs on URL change, heavily debounced
  // ═══════════════════════════════════════════════════════════════

  function scheduleEval() {
    if (_evalDebounce) clearTimeout(_evalDebounce);
    _evalDebounce = setTimeout(doEval, 500);
  }

  function doEval() {
    if (!_currentTimer) return;
    const timer = _currentTimer;
    const remaining = Math.max(0, timer.dailyLimitSeconds - timer.secondsUsed);
    const isExpired = remaining <= 0;
    const isActive = timer.sessionActive && !timer.isPaused && !isExpired;
    const feedUnlocked = !timer.enabled || isActive;

    if (feedUnlocked) { hideOverlay(); return; }

    const currentUrl = window.location.pathname;

    // Avoid re-evaluating the same URL (prevents repeated redirects)
    if (_lastEvalUrl === currentUrl) {
      // Still on same URL — just ensure overlay state is correct
      if (window.FocusShield.isFeedPage() && !window.FocusShield.isAllowedPage()) {
        showOverlay(isExpired, remaining);
      }
      return;
    }
    _lastEvalUrl = currentUrl;

    // Let platform handle it first
    if (window.FocusShield.onLocked) {
      const handled = window.FocusShield.onLocked(isExpired, remaining);
      if (handled) return;
    }

    // Default behavior
    if (window.FocusShield.isBlockedPage()) {
      hideOverlay();
      window.location.replace(window.FocusShield.getSavedUrl());
      return;
    }

    if (window.FocusShield.isAllowedPage()) {
      hideOverlay();
      return;
    }

    if (window.FocusShield.isFeedPage()) {
      showOverlay(isExpired, remaining);
      return;
    }

    // Unknown — don't block
    hideOverlay();
  }

  // ═══════════════════════════════════════════════════════════════
  // URL WATCHER
  // ═══════════════════════════════════════════════════════════════

  function startUrlWatcher() {
    if (_urlWatcher) return;
    let lastPath = window.location.pathname;
    _urlWatcher = setInterval(() => {
      const p = window.location.pathname;
      if (p !== lastPath) {
        lastPath = p;
        _lastEvalUrl = null;  // allow re-evaluation for new URL
        scheduleEval();
      }
    }, 400);
  }

  function stopUrlWatcher() {
    if (_urlWatcher) { clearInterval(_urlWatcher); _urlWatcher = null; }
  }

  // ═══════════════════════════════════════════════════════════════
  // MASTER UPDATE — timer ticks only update pill, never overlay
  // ═══════════════════════════════════════════════════════════════

  function updateUI(timer) {
    if (!timer) return;
    _currentTimer = timer;

    const remaining = Math.max(0, timer.dailyLimitSeconds - timer.secondsUsed);
    const isExpired = remaining <= 0;
    const isActive = timer.sessionActive && !timer.isPaused && !isExpired;
    const isPaused = timer.sessionActive && timer.isPaused;
    const feedUnlocked = !timer.enabled || isActive;

    // STATE TRANSITIONS
    if (_lastFeedUnlocked !== null && feedUnlocked !== _lastFeedUnlocked) {
      _lastFeedUnlocked = feedUnlocked;
      if (feedUnlocked) {
        stopUrlWatcher();
        hideOverlay();
        window.location.reload();
        return;
      } else {
        _lastEvalUrl = null;
        startUrlWatcher();
        scheduleEval();
      }
    } else if (_lastFeedUnlocked === null) {
      _lastFeedUnlocked = feedUnlocked;
      if (!feedUnlocked) {
        _lastEvalUrl = null;
        startUrlWatcher();
        scheduleEval();
      }
    }
    // NOTE: if still locked, we do NOT re-evaluate. Overlay stays stable.
    // Only URL changes trigger re-evaluation.

    // Always update pill
    updatePill(remaining, isExpired, isActive, isPaused);
  }

  function updatePill(remaining, isExpired, isActive, isPaused) {
    const d = document.getElementById("fs-timer-display");
    const dot = document.getElementById("fs-timer-dot");
    const s = document.getElementById("fs-btn-start");
    const p = document.getElementById("fs-btn-pause");
    const t = document.getElementById("fs-btn-stop");

    if (d) d.textContent = fmt(remaining);
    if (dot) dot.className = isExpired ? "fs-dot-expired" : isActive ? "fs-dot-active" : isPaused ? "fs-dot-paused" : "fs-dot-idle";

    if (s && p && t) {
      if (isExpired) {
        s.style.display = "none"; p.style.display = "none"; t.style.display = "none";
      } else if (isActive) {
        s.style.display = "none"; p.style.display = "inline-flex"; t.style.display = "inline-flex";
      } else if (isPaused) {
        s.style.display = "inline-flex"; s.textContent = "▶"; s.onclick = () => send("RESUME_SESSION");
        p.style.display = "none"; t.style.display = "inline-flex";
      } else {
        s.style.display = "inline-flex"; s.textContent = "▶"; s.onclick = () => send("START_SESSION");
        p.style.display = "none"; t.style.display = "none";
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // WARNINGS
  // ═══════════════════════════════════════════════════════════════

  function showWarning(msg, cls) {
    let el = document.getElementById("fs-warning-toast");
    if (!el) { el = document.createElement("div"); el.id = "fs-warning-toast"; document.body.appendChild(el); }
    el.className = `fs-toast fs-toast-${cls}`;
    el.textContent = msg; el.style.display = "block"; el.style.opacity = "1";
    setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.style.display = "none", 400); }, 4000);
  }

  // ═══════════════════════════════════════════════════════════════
  // MESSAGES
  // ═══════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener(msg => {
    if (["STATE_UPDATE","SESSION_STARTED","SESSION_RESUMED","SESSION_PAUSED","SESSION_STOPPED","SETTINGS_UPDATED","TIME_EXPIRED"].includes(msg.type)) {
      if (msg.type === "TIME_EXPIRED") showWarning("🛑 Time's up! Feeds locked.", "expired");
      updateUI(msg.timer);
    }
    if (msg.type === "FIVE_MIN_WARNING") showWarning("⚠️ 5 minutes remaining", "warning");
    if (msg.type === "ONE_MIN_WARNING") showWarning("🔴 1 minute remaining!", "danger");
  });

  // ═══════════════════════════════════════════════════════════════
  // STYLES
  // ═══════════════════════════════════════════════════════════════

  function injectStyles() {
    if (document.getElementById("fs-own-styles")) return;
    const el = document.createElement("style"); el.id = "fs-own-styles";
    el.textContent = `
#fs-timer-overlay{position:fixed;top:12px;right:12px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;font-size:13px;user-select:none}
#fs-timer-pill{display:flex;align-items:center;gap:8px;background:rgba(10,10,14,.88);backdrop-filter:blur(16px);padding:6px 12px;border-radius:20px;border:1px solid rgba(255,255,255,.08);box-shadow:0 4px 20px rgba(0,0,0,.4);color:#e7e9ea;transition:all .2s}
#fs-timer-pill:hover{border-color:rgba(255,255,255,.15)}
.fs-dot-active,.fs-dot-idle,.fs-dot-paused,.fs-dot-expired{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.fs-dot-active{background:#4ade80;animation:fsp 1.5s ease-in-out infinite}.fs-dot-idle{background:#71767b}
.fs-dot-paused{background:#ffa500;animation:fsp 2s ease-in-out infinite}.fs-dot-expired{background:#f4212e}
@keyframes fsp{0%,100%{opacity:1}50%{opacity:.5}}
#fs-timer-display{font-variant-numeric:tabular-nums;font-weight:600;min-width:38px;font-size:13px}
#fs-timer-controls{display:flex;gap:3px;align-items:center}
.fs-btn{width:26px;height:26px;border:none;border-radius:50%;cursor:pointer;font-size:10px;display:inline-flex;align-items:center;justify-content:center;transition:all .15s;color:#fff}
.fs-btn-start{background:#4ade80;color:#000}.fs-btn-start:hover{background:#22c55e;transform:scale(1.1)}
.fs-btn-pause{background:#ffa500;color:#000}.fs-btn-pause:hover{background:#e69500}
.fs-btn-stop{background:#71767b}.fs-btn-stop:hover{background:#f4212e}
#fs-lock-overlay{position:fixed;inset:0;z-index:2147483640;background:rgba(0,0,0,.92);backdrop-filter:blur(30px);display:none;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif}
.fs-lock-card{text-align:center;padding:48px 40px;background:rgba(22,22,30,.95);border:1px solid rgba(255,255,255,.06);border-radius:24px;max-width:400px;box-shadow:0 24px 80px rgba(0,0,0,.6)}
.fs-lock-icon{font-size:48px;margin-bottom:16px}
.fs-lock-title{font-size:24px;font-weight:800;color:#e7e9ea;margin:0 0 12px;letter-spacing:-.3px}
.fs-lock-text{font-size:15px;color:#71767b;line-height:1.5;margin:0 0 24px}.fs-lock-text strong{color:#e7e9ea}
.fs-lock-btn{display:inline-flex;align-items:center;gap:8px;padding:14px 32px;border-radius:9999px;border:none;background:#4ade80;color:#000;font-size:16px;font-weight:700;cursor:pointer;transition:all .2s;margin-bottom:16px}
.fs-lock-btn:hover{background:#22c55e;transform:scale(1.05)}
.fs-lock-subtext{font-size:13px;color:#536471;margin:0 0 16px}
.fs-lock-links{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:8px}
.fs-lock-link{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:9999px;background:rgba(255,255,255,.08);color:#93c5fd;border:none;cursor:pointer;font-size:13px;font-weight:600;transition:background .2s;font-family:inherit}
.fs-lock-link:hover{background:rgba(255,255,255,.14)}
#fs-warning-toast{position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:12px 24px;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;font-size:14px;font-weight:600;box-shadow:0 8px 32px rgba(0,0,0,.5);transition:opacity .4s;display:none}
.fs-toast-warning{background:rgba(255,165,0,.95);color:#000}
.fs-toast-danger,.fs-toast-expired{background:rgba(244,33,46,.95);color:#fff}
    `;
    (document.head || document.documentElement).appendChild(el);
  }

  // ═══════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════

  async function init() {
    injectStyles();
    if (document.body) ensureTimerPill();
    else document.addEventListener("DOMContentLoaded", ensureTimerPill);
    const state = await getState();
    if (state) updateUI(state.timer);
  }

  if (document.body) init();
  else document.addEventListener("DOMContentLoaded", init);
  window.addEventListener("load", () => setTimeout(init, 500));
})();
