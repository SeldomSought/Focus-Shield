/*
 * Focus Shield — YouTube (v5)
 *
 * YouTube is a heavy SPA that fires yt-navigate-finish on route changes.
 * We hook into that event to reset the eval state so shared.js re-evaluates.
 * The key fix: we do NOT fire on every popstate or mutation, only on
 * yt-navigate-finish and URL polling — both debounced by shared.js.
 */
(function () {
  "use strict";

  window.FocusShield.platform = "youtube";
  window.FocusShield.getSavedUrl = () => "/feed/library";

  window.FocusShield.isAllowedPage = function () {
    const p = window.location.pathname;
    // Watch a specific video (reachable from library/watch-later)
    if (p.startsWith("/watch")) return true;
    // Library and watch-later playlist
    if (p.startsWith("/feed/library")) return true;
    if (p.startsWith("/playlist")) return true;
    // Create / upload
    if (p.startsWith("/upload") || p.startsWith("/create") || p.startsWith("/studio")) return true;
    return false;
  };

  window.FocusShield.isFeedPage = function () {
    const p = window.location.pathname;
    return p === "/" || p === "/feed" || p === "/feed/" ||
      p.startsWith("/feed/subscriptions") || p.startsWith("/feed/trending");
  };

  window.FocusShield.isBlockedPage = function () {
    const p = window.location.pathname;
    return p.startsWith("/shorts") || p.startsWith("/feed/explore") ||
      p.startsWith("/results") || p.startsWith("/gaming") ||
      p.startsWith("/music") || p.startsWith("/news") || p.startsWith("/sports");
  };

  window.FocusShield.getAllowedLinks = () => [
    { url: "/feed/library", icon: "📚", label: "Library" },
    { url: "/playlist?list=WL", icon: "⏰", label: "Watch Later" },
  ];

})();
