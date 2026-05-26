(function () {
  "use strict";
  window.FocusShield.platform = "twitter";
  window.FocusShield.getSavedUrl = () => "/i/bookmarks";

  window.FocusShield.isAllowedPage = function () {
    const p = window.location.pathname;
    if (p.startsWith("/i/bookmarks")) return true;
    if (p.startsWith("/compose")) return true;
    if (p.startsWith("/intent/tweet")) return true;
    // Individual tweet pages — reachable from bookmarks
    if (/^\/[^/]+\/status\/\d+/.test(p)) return true;
    return false;
  };

  window.FocusShield.isFeedPage = function () {
    const p = window.location.pathname;
    return p === "/" || p === "/home" || p === "/home/";
  };

  window.FocusShield.isBlockedPage = function () {
    return ["/explore","/search","/notifications","/messages","/i/communities","/i/lists","/i/spaces"]
      .some(b => window.location.pathname.startsWith(b));
  };

  window.FocusShield.getAllowedLinks = () => [
    { url: "/i/bookmarks", icon: "📑", label: "Bookmarks" },
    { url: "/compose/post", icon: "✏️", label: "Post" },
  ];
})();
