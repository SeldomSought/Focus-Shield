/*
 * Focus Shield — Shared Content Script
 *
 * LOCKING MODEL: setInterval(enforce, 750)
 *   Every 750 ms, read _currentTimer and apply the correct state.
 *   No URL watchers, no debouncing, no state-transition guards.
 *   Simple enough to reason about; hard enough to silently break.
 *
 * UNLOCK: only when sessionActive && !isPaused && time remaining > 0.
 *         timer.enabled is intentionally ignored — blocking is always on.
 */

(function () {
  "use strict";

  if (window.__focusShieldLoaded) return;
  window.__focusShieldLoaded = true;

  // Platform scripts override these
  window.FocusShield = {
    platform: null,
    isAllowedPage: () => false,
    isFeedPage: () => false,
    isBlockedPage: () => false,
    getAllowedLinks: () => [],
    getSavedUrl: () => "/",
    onLocked: null,   // Instagram sets this to override default behaviour
  };

  let _currentTimer = null;

  // ═══════════════════════════════════════════════════════════════
  // BACKGROUND COMMUNICATION
  // ═══════════════════════════════════════════════════════════════

  function getState() {
    return new Promise(resolve => {
      let attempts = 0;
      function attempt() {
        attempts++;
        try {
          chrome.runtime.sendMessage({ type: "GET_STATE" }, r => {
            if (chrome.runtime.lastError || !r) {
              if (attempts < 3) { setTimeout(attempt, 400); } else { resolve(null); }
              return;
            }
            resolve(r);
          });
        } catch {
          if (attempts < 3) { setTimeout(attempt, 400); } else { resolve(null); }
        }
      }
      attempt();
    });
  }

  function send(type) {
    try {
      chrome.runtime.sendMessage({ type }, r => {
        if (chrome.runtime.lastError) return;
        if (r?.timer) _currentTimer = r.timer;
      });
    } catch {}
  }

  function fmt(s) {
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
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
          <button id="fs-btn-stop"  class="fs-btn fs-btn-stop"  title="Stop"  style="display:none">■</button>
        </div>
      </div>`;
    document.documentElement.appendChild(el);
    document.getElementById("fs-btn-start").onclick = () => send("START_SESSION");
    document.getElementById("fs-btn-pause").onclick = () => send("PAUSE_SESSION");
    document.getElementById("fs-btn-stop").onclick  = () => send("STOP_SESSION");
    makeDraggable(el);
  }

  function updatePill(remaining, isExpired, isActive, isPaused) {
    ensureTimerPill();
    const d   = document.getElementById("fs-timer-display");
    const dot = document.getElementById("fs-timer-dot");
    const s   = document.getElementById("fs-btn-start");
    const p   = document.getElementById("fs-btn-pause");
    const t   = document.getElementById("fs-btn-stop");

    if (d) d.textContent = fmt(remaining);
    if (dot) dot.className = isExpired ? "fs-dot-expired"
                           : isActive  ? "fs-dot-active"
                           : isPaused  ? "fs-dot-paused"
                           : "fs-dot-idle";
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
  // LOCK OVERLAY
  // ═══════════════════════════════════════════════════════════════

  function showOverlay(isExpired, remaining) {
    let ov = document.getElementById("fs-lock-overlay");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "fs-lock-overlay";
      document.documentElement.appendChild(ov);
    }

    // Skip full rebuild if already showing this state for this URL
    if (ov.dataset.url === location.pathname &&
        ov.dataset.exp === String(isExpired) &&
        ov.style.display === "flex") return;

    ov.dataset.url = location.pathname;
    ov.dataset.exp = String(isExpired);
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

    requestAnimationFrame(() => {
      const sb = document.getElementById("fs-lock-start-btn");
      if (sb) sb.onclick = () => send("START_SESSION");
      links.forEach((l, i) => {
        const btn = document.getElementById(`fs-nav-${i}`);
        if (btn) btn.onclick = () => { location.href = l.url; };
      });
    });
  }

  function hideOverlay() {
    const ov = document.getElementById("fs-lock-overlay");
    if (ov) { ov.style.display = "none"; ov.dataset.url = ""; }
  }

  // ═══════════════════════════════════════════════════════════════
  // FS-LOCKED CLASS  (drives platform CSS feed-suppression rules)
  // ═══════════════════════════════════════════════════════════════

  function applyLockedClass() {
    document.body?.classList.add("fs-locked");
    document.documentElement.classList.add("fs-locked");
  }

  function removeLockedClass() {
    document.body?.classList.remove("fs-locked");
    document.documentElement.classList.remove("fs-locked");
  }

  // ═══════════════════════════════════════════════════════════════
  // ENFORCE  — called every 750 ms
  // ═══════════════════════════════════════════════════════════════

  function enforce() {
    if (!_currentTimer) return;

    const remaining = Math.max(0, _currentTimer.dailyLimitSeconds - _currentTimer.secondsUsed);
    const isExpired  = remaining <= 0;
    const isActive   = _currentTimer.sessionActive && !_currentTimer.isPaused && !isExpired;
    const isPaused   = _currentTimer.sessionActive && _currentTimer.isPaused;

    updatePill(remaining, isExpired, isActive, isPaused);

    // ── Unlocked (active session) ──────────────────────────────
    if (isActive) {
      removeLockedClass();
      hideOverlay();
      return;
    }

    // ── Locked ────────────────────────────────────────────────
    applyLockedClass();

    // Instagram (and any future platform) provides its own onLocked handler
    if (typeof window.FocusShield.onLocked === "function") {
      window.FocusShield.onLocked(isExpired, remaining);
      return;
    }

    // Default: allowed → pass; feed → overlay; everything else → redirect
    if (window.FocusShield.isAllowedPage()) {
      hideOverlay();
      return;
    }

    if (window.FocusShield.isFeedPage()) {
      showOverlay(isExpired, remaining);
      return;
    }

    // Blocked or unknown page — redirect to saved/bookmarks
    const dest = window.FocusShield.getSavedUrl();
    if (location.pathname !== dest) {
      location.replace(dest);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MESSAGES FROM BACKGROUND
  // ═══════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.timer) _currentTimer = msg.timer;
    if (msg.type === "TIME_EXPIRED")   showWarning("🛑 Time's up! Feeds locked.", "expired");
    if (msg.type === "FIVE_MIN_WARNING") showWarning("⚠️ 5 minutes remaining", "warning");
    if (msg.type === "ONE_MIN_WARNING")  showWarning("🔴 1 minute remaining!", "danger");
  });

  // ═══════════════════════════════════════════════════════════════
  // WARNINGS
  // ═══════════════════════════════════════════════════════════════

  function showWarning(msg, cls) {
    let el = document.getElementById("fs-warning-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "fs-warning-toast";
      document.documentElement.appendChild(el);
    }
    el.className = `fs-toast fs-toast-${cls}`;
    el.textContent = msg;
    el.style.display = "block";
    el.style.opacity = "1";
    setTimeout(() => { el.style.opacity = "0"; setTimeout(() => { el.style.display = "none"; }, 400); }, 4000);
  }

  // ═══════════════════════════════════════════════════════════════
  // DRAGGABLE PILL
  // ═══════════════════════════════════════════════════════════════

  function makeDraggable(el) {
    let dragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;

    try {
      chrome.storage.local.get("fs_pill_pos", r => {
        if (chrome.runtime.lastError || !r.fs_pill_pos) return;
        el.style.right = "auto";
        el.style.left = r.fs_pill_pos.left;
        el.style.top  = r.fs_pill_pos.top;
      });
    } catch {}

    el.addEventListener("mousedown", e => {
      if (e.button !== 0 || e.target.closest("button")) return;
      dragging = true;
      const rect = el.getBoundingClientRect();
      el.style.right = "auto";
      el.style.left  = rect.left + "px";
      el.style.top   = rect.top  + "px";
      origLeft = rect.left; origTop = rect.top;
      startX = e.clientX;  startY = e.clientY;
      el.style.transition = "none";
      el.style.cursor = "grabbing";
      e.preventDefault();
    });

    document.addEventListener("mousemove", e => {
      if (!dragging) return;
      const x = Math.max(4, Math.min(innerWidth  - el.offsetWidth  - 4, origLeft + e.clientX - startX));
      const y = Math.max(4, Math.min(innerHeight - el.offsetHeight - 4, origTop  + e.clientY - startY));
      el.style.left = x + "px";
      el.style.top  = y + "px";
    });

    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      el.style.transition = "";
      el.style.cursor = "grab";
      try {
        chrome.storage.local.set({ fs_pill_pos: { left: el.style.left, top: el.style.top } });
      } catch {}
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // STYLES
  // ═══════════════════════════════════════════════════════════════

  function injectStyles() {
    if (document.getElementById("fs-own-styles")) return;
    const el = document.createElement("style"); el.id = "fs-own-styles";
    el.textContent = `
#fs-timer-overlay{position:fixed;top:12px;right:12px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;font-size:13px;user-select:none;cursor:grab}
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
    ensureTimerPill();

    const state = await getState();
    if (state?.timer) {
      _currentTimer = state.timer;
    } else {
      // Background unreachable — default to locked
      _currentTimer = {
        secondsUsed: 0, dailyLimitSeconds: 1800,
        sessionActive: false, isPaused: false, enabled: true,
        lastResetDate: new Date().toISOString().split("T")[0],
      };
    }

    enforce();                    // enforce immediately on load
    setInterval(enforce, 750);    // then every 750 ms
  }

  if (document.readyState !== "loading") {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  }
})();
