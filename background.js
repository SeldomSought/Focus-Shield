/*
 * Focus Shield — Background Service Worker v3
 *
 * Two separate states:
 *   focusEnabled  — whether the shield is protecting the user
 *   sessionActive — whether a timed free-scroll window is open
 *
 * When focusEnabled=true and sessionActive=false → block feeds.
 * When focusEnabled=true and sessionActive=true  → allow; count down.
 * When focusEnabled=false                        → allow everything.
 *
 * Remaining time is tracked via sessionStartedAt + remainingSeconds
 * so it stays accurate even when the service worker is asleep.
 */

const DEBUG = true;
const log = (...a) => DEBUG && console.log("[FS BG]", ...a);

// ── Storage defaults ───────────────────────────────────────────

const DEFAULTS = {
  focusEnabled: true,
  sessionActive: false,
  dailyLimitMinutes: 30,
  remainingSeconds: 1800,
  lastResetDate: todayStr(),
  sessionStartedAt: null,
};

function todayStr() {
  // YYYY-MM-DD in local time (not UTC)
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

async function getState() {
  const r = await chrome.storage.local.get(null);
  return { ...DEFAULTS, ...r };
}

async function patchState(updates) {
  await chrome.storage.local.set(updates);
}

// How much time is actually left right now, accounting for elapsed session time.
function calcRemaining(state) {
  if (!state.sessionActive || !state.sessionStartedAt) return state.remainingSeconds;
  const elapsed = Math.floor((Date.now() - state.sessionStartedAt) / 1000);
  return Math.max(0, state.remainingSeconds - elapsed);
}

// ── URL Classifier ─────────────────────────────────────────────
// Returns { platform, surface, reason, allowedReferenceUrl,
//           allowedReferenceLabel, creationUrl, creationLabel }
// Blocking UX (overlay) is handled entirely by the content script.

function classifyUrl(urlStr) {
  let url;
  try { url = new URL(urlStr); } catch {
    return { platform: "other", surface: "neutral", reason: "invalid url" };
  }

  const host = url.hostname.replace(/^(www\.|mobile\.)/, "");
  const path = url.pathname;

  // ── X / Twitter ──
  if (host === "x.com" || host === "twitter.com") {
    const composeHost = host === "twitter.com" ? "twitter.com" : "x.com";
    const extras = {
      allowedReferenceUrl: "https://x.com/i/bookmarks", allowedReferenceLabel: "Bookmarks",
      creationUrl: `https://${composeHost}/compose/post`, creationLabel: "Compose Post",
    };
    if (path.startsWith("/i/bookmarks"))       return { platform:"x", surface:"allowed", reason:"bookmarks", ...extras };
    if (path.startsWith("/compose"))            return { platform:"x", surface:"allowed", reason:"compose", ...extras };
    if (path.startsWith("/intent/tweet"))       return { platform:"x", surface:"allowed", reason:"intent", ...extras };
    if (path.startsWith("/messages"))           return { platform:"x", surface:"allowed", reason:"messages", ...extras };
    if (/^\/[^/]+\/status\/\d+/.test(path))    return { platform:"x", surface:"allowed", reason:"status page", ...extras };
    if (path === "/" || path === "")            return { platform:"x", surface:"blocked", reason:"root feed", ...extras };
    if (path.startsWith("/home"))               return { platform:"x", surface:"blocked", reason:"home feed", ...extras };
    if (path.startsWith("/explore"))            return { platform:"x", surface:"blocked", reason:"explore", ...extras };
    if (path.startsWith("/notifications"))      return { platform:"x", surface:"blocked", reason:"notifications", ...extras };
    if (path.startsWith("/search"))             return { platform:"x", surface:"blocked", reason:"search", ...extras };
    return { platform:"x", surface:"neutral", reason:"profile or other", ...extras };
  }

  // ── YouTube ──
  if (host === "studio.youtube.com") return { platform:"youtube", surface:"allowed", reason:"studio",
    allowedReferenceUrl:"https://www.youtube.com/feed/history", allowedReferenceLabel:"History",
    creationUrl:"https://www.youtube.com/upload", creationLabel:"Upload Video" };
  if (host === "youtube.com") {
    const extras = {
      allowedReferenceUrl: "https://www.youtube.com/feed/history", allowedReferenceLabel: "History",
      creationUrl: "https://www.youtube.com/upload", creationLabel: "Upload Video",
    };
    if (path.startsWith("/watch"))              return { platform:"youtube", surface:"allowed", reason:"watch", ...extras };
    if (path.startsWith("/feed/history"))       return { platform:"youtube", surface:"allowed", reason:"history", ...extras };
    if (path.startsWith("/playlist"))           return { platform:"youtube", surface:"allowed", reason:"playlist", ...extras };
    if (path.startsWith("/upload"))             return { platform:"youtube", surface:"allowed", reason:"upload", ...extras };
    if (path.startsWith("/create"))             return { platform:"youtube", surface:"allowed", reason:"create", ...extras };
    if (path === "/" || path === "")            return { platform:"youtube", surface:"blocked", reason:"home feed", ...extras };
    if (path.startsWith("/feed/subscriptions")) return { platform:"youtube", surface:"blocked", reason:"subscriptions", ...extras };
    if (path.startsWith("/feed/trending"))      return { platform:"youtube", surface:"blocked", reason:"trending", ...extras };
    if (path.startsWith("/feed/explore"))       return { platform:"youtube", surface:"blocked", reason:"explore", ...extras };
    if (path.startsWith("/shorts"))             return { platform:"youtube", surface:"blocked", reason:"shorts", ...extras };
    if (path.startsWith("/results"))            return { platform:"youtube", surface:"blocked", reason:"search results", ...extras };
    if (path.startsWith("/gaming"))             return { platform:"youtube", surface:"blocked", reason:"gaming", ...extras };
    if (path.startsWith("/trending"))           return { platform:"youtube", surface:"blocked", reason:"trending", ...extras };
    return { platform:"youtube", surface:"neutral", reason:"other youtube page", ...extras };
  }

  // ── Instagram ──
  if (host === "instagram.com") {
    const extras = {
      allowedReferenceUrl: "https://www.instagram.com/direct/inbox/", allowedReferenceLabel: "Direct Messages",
      creationUrl: "https://www.instagram.com/", creationLabel: "Open Instagram to Post",
    };
    if (path.startsWith("/direct/inbox"))       return { platform:"instagram", surface:"allowed", reason:"direct messages", ...extras };
    if (path.startsWith("/accounts"))           return { platform:"instagram", surface:"allowed", reason:"account settings", ...extras };
    if (/^\/p\//.test(path))                    return { platform:"instagram", surface:"allowed", reason:"individual post", ...extras };
    // Root: blocked by default; content script applies creationIntent bypass
    if (path === "/" || path === "")            return { platform:"instagram", surface:"blocked", reason:"home feed", ...extras };
    if (path.startsWith("/explore"))            return { platform:"instagram", surface:"blocked", reason:"explore", ...extras };
    if (path.startsWith("/reels"))              return { platform:"instagram", surface:"blocked", reason:"reels", ...extras };
    if (path.startsWith("/stories"))            return { platform:"instagram", surface:"blocked", reason:"stories", ...extras };
    return { platform:"instagram", surface:"neutral", reason:"profile or other", ...extras };
  }

  return { platform:"other", surface:"neutral", reason:"untracked platform" };
}

// ── Broadcast STATE_UPDATE to all content scripts ─────────────
// The content script overlay handles all blocking UX.
// Background does NOT redirect tabs — it only manages state
// and tells content scripts when something changed.

function notifyAllTabs() {
  chrome.tabs.query({}, tabs => {
    for (const tab of tabs) {
      try { chrome.tabs.sendMessage(tab.id, { type: "STATE_UPDATE" }); } catch {}
    }
  });
}

// ── Daily reset ────────────────────────────────────────────────

async function checkReset() {
  const state = await getState();
  const today = todayStr();
  if (state.lastResetDate === today) return;

  log("Daily reset:", state.lastResetDate, "→", today);
  await patchState({
    remainingSeconds: state.dailyLimitMinutes * 60,
    sessionActive: false,
    sessionStartedAt: null,
    lastResetDate: today,
  });
  notifyAllTabs();
}

// ── Timer tick ─────────────────────────────────────────────────

async function tick() {
  const state = await getState();
  if (!state.sessionActive) return;

  const remaining = calcRemaining(state);
  log("Tick: remaining", remaining, "s");

  if (remaining <= 0) {
    log("Session time expired");
    await patchState({ sessionActive: false, sessionStartedAt: null, remainingSeconds: 0 });
    notifyAllTabs();
  }
  // No need to write anything else — calcRemaining derives the value live.
}


// ── Alarms ────────────────────────────────────────────────────

function setupAlarms() {
  chrome.alarms.create("fs_tick",  { periodInMinutes: 0.5 });
  chrome.alarms.create("fs_reset", { periodInMinutes: 1   });
}

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === "fs_tick")  tick();
  if (a.name === "fs_reset") checkReset();
});

// ── Install / Startup ─────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  log("onInstalled:", details.reason);
  const existing = await chrome.storage.local.get(null);
  const init = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (!(k in existing)) init[k] = v;
  }
  if (Object.keys(init).length) {
    log("Initializing storage defaults:", init);
    await chrome.storage.local.set(init);
  }
  await chrome.alarms.clearAll();
  setupAlarms();
  await checkReset();
});

chrome.runtime.onStartup.addListener(async () => {
  log("onStartup");
  await checkReset();
  // Clear stale session state — sessionActive should never survive a browser restart
  const state = await getState();
  if (state.sessionActive) {
    log("Clearing stale session from previous browser session");
    await patchState({ sessionActive: false, sessionStartedAt: null });
  }
  setupAlarms();
});

// ── Messages ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  (async () => {
    log("Message:", msg.type);
    const state = await getState();

    switch (msg.type) {

      case "GET_STATE": {
        // Return state with accurate remaining time
        respond({ ...state, remainingSeconds: calcRemaining(state) });
        break;
      }

      case "CLASSIFY_URL": {
        respond(classifyUrl(msg.url));
        break;
      }

      case "START_SESSION": {
        const remaining = calcRemaining(state);
        if (remaining <= 0) { respond({ success: false, reason: "no_time_left" }); break; }
        if (state.sessionActive) { respond({ success: true, alreadyActive: true }); break; }
        await patchState({ sessionActive: true, sessionStartedAt: Date.now() });
        notifyAllTabs();
        respond({ success: true });
        break;
      }

      case "STOP_SESSION": {
        // Persist how much time was actually remaining before stopping
        const remaining = calcRemaining(state);
        await patchState({ sessionActive: false, sessionStartedAt: null, remainingSeconds: remaining });
        notifyAllTabs();
        notifyAllTabs();
        respond({ success: true });
        break;
      }

      case "SET_FOCUS_ENABLED": {
        const enabled = !!msg.enabled;
        await patchState({ focusEnabled: enabled });
        if (!enabled) {
          // Stop any session when shield is disabled
          await patchState({ sessionActive: false, sessionStartedAt: null });
        } else {
          notifyAllTabs();
        }
        notifyAllTabs();
        respond({ success: true });
        break;
      }

      case "RESET_TODAY": {
        log("Reset today triggered");
        const newRemaining = state.dailyLimitMinutes * 60;
        await patchState({
          remainingSeconds: newRemaining,
          sessionActive: false,
          sessionStartedAt: null,
          lastResetDate: todayStr(),
        });
        notifyAllTabs();
        respond({ success: true });
        break;
      }

      case "SET_LIMIT": {
        const mins = parseInt(msg.minutes, 10);
        if (!mins || mins < 1 || mins > 240) { respond({ success: false }); break; }
        await patchState({ dailyLimitMinutes: mins, remainingSeconds: mins * 60 });
        respond({ success: true });
        break;
      }

      default:
        respond({ error: "unknown message type: " + msg.type });
    }
  })();
  return true; // keep channel open for async respond
});

// Run on service worker load (catches cases where alarms don't exist yet)
checkReset();
log("Service worker loaded");
