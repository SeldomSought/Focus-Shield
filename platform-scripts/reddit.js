(function () {
  "use strict";
  window.FocusShield.platform = "reddit";
  window.FocusShield.getSavedUrl = () => "/saved";

  window.FocusShield.isAllowedPage = function () {
    const p = window.location.pathname;
    if (p.includes("/saved")) return true;
    if (p.includes("/submit")) return true;
    // Comment threads — accessible by clicking a saved post
    if (/^\/r\/[^/]+\/comments\//.test(p)) return true;
    return false;
  };

  window.FocusShield.isFeedPage = function () {
    const p = window.location.pathname;
    return p === "/" || p === "/home" || p === "/home/" ||
      p === "/r/popular" || p.startsWith("/r/popular/") ||
      p === "/r/all" || p.startsWith("/r/all/") ||
      /^\/r\/[^/]+\/?$/.test(p);
  };

  window.FocusShield.isBlockedPage = function () {
    const p = window.location.pathname;
    return p.startsWith("/search") || p.startsWith("/notifications") || p.startsWith("/chat");
  };

  window.FocusShield.getAllowedLinks = () => [
    { url: "/saved", icon: "📑", label: "Saved" },
    { url: "/submit", icon: "✏️", label: "Create Post" },
  ];
})();
