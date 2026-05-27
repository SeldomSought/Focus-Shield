/*
 * Focus Shield — Instagram (v5)
 *
 * PROBLEM: Instagram requires /{username}/saved/ for saved posts.
 *          We can't show an overlay and navigate from it because:
 *          - /accounts/saved/ is NOT a real route
 *          - pushState doesn't work with Instagram's React router
 *          - The overlay covers the nav, so users can't self-navigate
 *
 * SOLUTION: Redirect-based locking. No overlay at all.
 *   - Feed (/) → detect username → redirect to /{username}/saved/
 *   - If username not found → redirect to /accounts/edit/ (always works)
 *   - Blocked pages → redirect to saved
 *   - Allowed pages → zero interference
 *   - User can navigate freely using Instagram's own nav on allowed pages
 *
 * USERNAME DETECTION (in priority order):
 *   1. Cached from previous detection
 *   2. Profile link in nav (aria-label="Profile")
 *   3. Config/sharedData embedded in page
 *   4. Meta tags
 */
(function () {
  "use strict";

  window.FocusShield.platform = "instagram";

  let _detectedUsername = null;

  // ── Username detection ──────────────────────────────────

  function detectUsername() {
    if (_detectedUsername) return _detectedUsername;

    // Method 1: Profile link in nav
    const selectors = [
      'a[href][aria-label="Profile"]',
      '[role="navigation"] a[href][aria-label="Profile"]',
      'nav a[href][aria-label="Profile"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const href = el.getAttribute("href") || "";
        const m = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
        if (m && m[1] !== "accounts" && m[1] !== "explore" && m[1] !== "reels" && m[1] !== "direct") {
          _detectedUsername = m[1];
          return _detectedUsername;
        }
      }
    }

    // Method 2: Any nav link that looks like a profile (single segment, not a system route)
    const systemPaths = new Set(["/", "/home", "/explore", "/explore/", "/reels", "/reels/",
      "/direct", "/direct/", "/accounts", "/create", "/stories"]);
    const navLinks = document.querySelectorAll('nav a[href], [role="navigation"] a[href]');
    for (const a of navLinks) {
      const href = a.getAttribute("href") || "";
      if (/^\/[a-zA-Z0-9._]+\/?$/.test(href) && !systemPaths.has(href.replace(/\/$/, ""))) {
        const m = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
        if (m) { _detectedUsername = m[1]; return _detectedUsername; }
      }
    }

    // Method 3: Page source / embedded data
    try {
      const scripts = document.querySelectorAll('script[type="application/json"]');
      for (const s of scripts) {
        const txt = s.textContent || "";
        const m = txt.match(/"username":"([a-zA-Z0-9._]+)"/);
        if (m) { _detectedUsername = m[1]; return _detectedUsername; }
      }
    } catch {}

    // Method 4: Meta tags
    try {
      const meta = document.querySelector('meta[property="al:ios:url"]');
      if (meta?.content) {
        const m = meta.content.match(/username=([a-zA-Z0-9._]+)/);
        if (m) { _detectedUsername = m[1]; return _detectedUsername; }
      }
    } catch {}

    return null;
  }

  function getSavedUrl() {
    const u = detectUsername();
    return u ? `/${u}/saved/` : "/accounts/edit/";
  }

  window.FocusShield.getSavedUrl = getSavedUrl;

  // ── Page classifiers ────────────────────────────────────

  window.FocusShield.isAllowedPage = function () {
    const p = window.location.pathname;
    if (p.includes("/saved")) return true;
    if (p.startsWith("/create")) return true;
    // Fallback redirect target when username not yet detected — allowed so we don't loop
    if (p.startsWith("/accounts/edit")) return true;
    return false;
  };

  window.FocusShield.isFeedPage = function () {
    const p = window.location.pathname;
    return p === "/" || p === "/home" || p === "/home/";
  };

  window.FocusShield.isBlockedPage = function () {
    const p = window.location.pathname;
    if (p.startsWith("/explore")) return true;
    if (p === "/reels" || p === "/reels/") return true;
    if (p === "/direct" || p === "/direct/" || p === "/direct/inbox" || p === "/direct/inbox/") return true;
    return false;
  };

  // ── Lock behavior: REDIRECT, no overlay ─────────────────
  // enforce() in shared.js calls this every 750 ms when locked.
  // Keep it idempotent — no internal timers or state needed.

  window.FocusShield.onLocked = function (isExpired, remaining) {
    // On an allowed page — if it's the /accounts/edit/ fallback and we
    // can now detect the username, advance to saved.
    if (window.FocusShield.isAllowedPage()) {
      if (window.location.pathname.startsWith("/accounts/edit")) {
        const dest = getSavedUrl();
        if (!dest.startsWith("/accounts/edit")) {
          window.location.replace(dest);
        }
      }
      return;
    }

    // Not on an allowed page — redirect immediately.
    // getSavedUrl() returns /{username}/saved/ if detectable, else /accounts/edit/.
    const dest = getSavedUrl();
    if (window.location.pathname !== dest) {
      window.location.replace(dest);
    }
  };

  // ── Allowed links (for other UI that might use them) ────

  window.FocusShield.getAllowedLinks = function () {
    return [
      { url: getSavedUrl(), icon: "📑", label: "Saved" },
      { url: "/create/style/", icon: "✏️", label: "Create" },
    ];
  };

})();
