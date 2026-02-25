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
    if (p.startsWith("/p/")) return true;
    if (p.startsWith("/reel/")) return true;
    if (p.startsWith("/stories/")) return true;
    if (p.startsWith("/accounts/")) return true;
    if (p.startsWith("/direct/t/")) return true;
    // Profile pages
    const systemRoutes = ["/", "/home", "/explore", "/reels", "/direct"];
    if (/^\/[a-zA-Z0-9._]+\/?$/.test(p)) {
      const clean = p.replace(/\/$/, "");
      if (!systemRoutes.includes(clean)) return true;
    }
    // Profile sub-pages
    if (/^\/[a-zA-Z0-9._]+\/(followers|following|tagged|saved|reels)\/?/.test(p)) return true;
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

  window.FocusShield.onLocked = function (isExpired, remaining) {
    const p = window.location.pathname;

    // Blocked → redirect to saved
    if (window.FocusShield.isBlockedPage()) {
      window.location.replace(getSavedUrl());
      return true; // handled
    }

    // Allowed → do nothing
    if (window.FocusShield.isAllowedPage()) {
      return true; // handled (no overlay needed)
    }

    // Feed → redirect to saved (no overlay!)
    if (window.FocusShield.isFeedPage()) {
      // Try to detect username first. If page hasn't loaded yet, wait and retry.
      const url = getSavedUrl();
      if (url === "/accounts/edit/") {
        // Username not found yet. Wait for nav to render, then try again.
        waitForUsername(() => {
          window.location.replace(getSavedUrl());
        });
      } else {
        window.location.replace(url);
      }
      return true; // handled
    }

    return true; // handled (unknown page — don't show overlay)
  };

  // Wait for Instagram's nav to render so we can detect the username
  function waitForUsername(callback) {
    let attempts = 0;
    const tryDetect = () => {
      attempts++;
      const u = detectUsername();
      if (u) {
        callback();
      } else if (attempts < 20) {
        setTimeout(tryDetect, 300);
      } else {
        // Give up — redirect to settings page as fallback
        callback();
      }
    };
    // Give Instagram a moment to render
    setTimeout(tryDetect, 500);
  }

  // ── Allowed links (for other UI that might use them) ────

  window.FocusShield.getAllowedLinks = function () {
    return [
      { url: getSavedUrl(), icon: "📑", label: "Saved" },
      { url: "/create/style/", icon: "✏️", label: "Create" },
    ];
  };

})();
