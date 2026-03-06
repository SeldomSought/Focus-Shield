(function () {
  "use strict";
  window.FocusShield.platform = "facebook";
  window.FocusShield.getSavedUrl = () => "/saved";

  const BLOCKED = ["/watch","/marketplace","/gaming","/reels","/news","/groups/feed","/notifications","/search"];

  window.FocusShield.isAllowedPage = function () {
    const p = window.location.pathname;
    if (p.startsWith("/saved")) return true;
    if (p.includes("/posts/")) return true;
    if (p.startsWith("/photo") || p.startsWith("/permalink") || p.startsWith("/story.php")) return true;
    if (p.startsWith("/settings") || p.startsWith("/profile") || p.startsWith("/me")) return true;
    if (p.includes("/composer") || p.includes("/create")) return true;
    if (/^\/groups\/\d+/.test(p) && !p.includes("/feed")) return true;
    if (/^\/[a-zA-Z0-9.]+\/?$/.test(p) && p !== "/" && p !== "/home" &&
        !BLOCKED.some(b => p.startsWith(b))) return true;
    return false;
  };

  window.FocusShield.isFeedPage = function () {
    const p = window.location.pathname;
    return p === "/" || p === "/home" || p === "/home.php";
  };

  window.FocusShield.isBlockedPage = function () {
    return BLOCKED.some(b => window.location.pathname.startsWith(b));
  };

  window.FocusShield.getAllowedLinks = () => [
    { url: "/saved", icon: "📑", label: "Saved" },
  ];
})();
