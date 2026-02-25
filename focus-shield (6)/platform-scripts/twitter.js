(function () {
  "use strict";
  window.FocusShield.platform = "twitter";
  window.FocusShield.getSavedUrl = () => "/i/bookmarks";

  window.FocusShield.isAllowedPage = function () {
    const p = window.location.pathname;
    if (p.startsWith("/i/bookmarks")) return true;
    if (p.includes("/compose")) return true;
    if (p.startsWith("/settings")) return true;
    if (/^\/[^/]+\/status\/\d+/.test(p)) return true;
    if (p.startsWith("/intent/")) return true;
    if (/^\/[a-zA-Z0-9_]+\/?$/.test(p) &&
        !["/","/home","/explore","/search","/notifications","/messages"].includes(p)) return true;
    if (/^\/[a-zA-Z0-9_]+\/(followers|following|likes|media|with_replies)/.test(p)) return true;
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
