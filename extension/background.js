/*
 * Focus Shield — Background Service Worker (v4)
 *
 * PROTECTION MODEL:
 *   - Settings/disable require passphrase OR active session
 *   - Setup flow forces passphrase creation on first install
 *   - Extension disable/removal detected via alive-timestamp gaps
 *   - Webhook heartbeat every 5 min (silence = tamper)
 *   - Uninstall URL opens accountability page
 *   - Delta-time tick model: real elapsed seconds, not assumed 1s per alarm
 *   - Escape interrupt window when chrome://extensions opened while locked
 */

const DEFAULT_TIMER = {
  secondsUsed: 0, dailyLimitSeconds: 1800,
  lastResetDate: new Date().toISOString().split("T")[0],
  sessionActive: false, isPaused: false, enabled: true,
  lastTickAt: null,
};

const DEFAULT_PLATFORMS = {
  twitter: { enabled: true, secondsUsed: 0 },
  reddit: { enabled: true, secondsUsed: 0 },
  youtube: { enabled: true, secondsUsed: 0 },
  instagram: { enabled: true, secondsUsed: 0 },
  facebook: { enabled: true, secondsUsed: 0 },
};

const DEFAULT_COMMITMENT = {
  locked: false, passphraseHash: null, lockedAt: null,
  pendingDisable: null,
  webhookUrl: null, lastHeartbeat: null, dailyLog: [],
  deterrenceLevel: "off",
};

const DEFAULT_META = {
  setupDone: false,
  installDate: null,
  lastAliveTimestamp: Date.now(),
  streakDays: 0,
  streakStartDate: null,
  totalDaysUsed: 0,
  disableEvents: [],
};

const DOMAINS = {
  "twitter.com":"twitter","x.com":"twitter","mobile.twitter.com":"twitter","mobile.x.com":"twitter",
  "www.reddit.com":"reddit","old.reddit.com":"reddit","reddit.com":"reddit",
  "www.youtube.com":"youtube","youtube.com":"youtube","m.youtube.com":"youtube",
  "www.instagram.com":"instagram","instagram.com":"instagram",
  "www.facebook.com":"facebook","facebook.com":"facebook","m.facebook.com":"facebook","web.facebook.com":"facebook",
};

// ── Deterrence messages ────────────────────────────────────

const DETERRENCE_MESSAGES = {
  firm: [
    "You set this rule yourself. Don't quit at the first urge.",
    "Start a session if you genuinely need this — that's what it's for.",
    "The rule exists because past-you knew present-you would want to break it.",
    "One urge isn't an emergency. It passes in 90 seconds.",
  ],
  hard: [
    "You set this rule. Breaking it now means the version of you that set it was right to distrust you.",
    "This isn't the first time you've felt this urge. It's never actually urgent.",
    "Start a session and use your time. Don't just dismantle the fence.",
    "You said you wanted to change. Here's the moment where that means something.",
  ],
};

function getDeterrenceMessage(level) {
  const msgs = DETERRENCE_MESSAGES[level];
  if (!msgs) return null;
  return msgs[Math.floor(Math.random() * msgs.length)];
}

// ── Storage ────────────────────────────────────────────────

async function get(key, def) { const r = await chrome.storage.local.get(key); return r[key] ? { ...def, ...r[key] } : { ...def }; }
async function set(key, val) { await chrome.storage.local.set({ [key]: val }); }

const getTimer = () => get("fs_timer", DEFAULT_TIMER);
const setTimer = (t) => set("fs_timer", t);
const getPlatforms = () => get("fs_platforms", DEFAULT_PLATFORMS);
const setPlatforms = (p) => set("fs_platforms", p);
const getCommitment = () => get("fs_commitment", DEFAULT_COMMITMENT);
const setCommitment = (c) => set("fs_commitment", c);
const getMeta = () => get("fs_meta", DEFAULT_META);
const setMeta = (m) => set("fs_meta", m);

// ── Uninstall URL ─────────────────────────────────────────

chrome.runtime.setUninstallURL("https://focusshield.app/uninstalled?source=extension&t=" + Date.now());

// ── Install / Startup ─────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  const meta = await getMeta();
  if (details.reason === "install") {
    meta.installDate = Date.now();
    meta.streakStartDate = new Date().toISOString().split("T")[0];
    meta.setupDone = false;
  }
  meta.lastAliveTimestamp = Date.now();
  await setMeta(meta);
  // Recreate alarms on install/update
  chrome.alarms.create("fs_tick", { periodInMinutes: 0.5 });
  chrome.alarms.create("fs_reset", { periodInMinutes: 1 });
  chrome.alarms.create("fs_heartbeat", { periodInMinutes: 5 });
});

chrome.runtime.onStartup.addListener(async () => {
  await detectTampering();
  const meta = await getMeta();
  meta.lastAliveTimestamp = Date.now();
  await setMeta(meta);
});

// ── Tamper Detection ──────────────────────────────────────

async function detectTampering() {
  const meta = await getMeta();
  const gap = Date.now() - (meta.lastAliveTimestamp || Date.now());

  if (gap > 120000) { // > 2 minutes
    const event = {
      timestamp: Date.now(),
      durationMs: gap,
      detected: new Date().toISOString(),
    };
    meta.disableEvents.push(event);
    if (meta.disableEvents.length > 50) meta.disableEvents = meta.disableEvents.slice(-50);
    meta.streakDays = 0;
    meta.streakStartDate = new Date().toISOString().split("T")[0];
    await setMeta(meta);

    const c = await getCommitment();
    if (c.webhookUrl) {
      fetch(c.webhookUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "tamper_detected", ts: new Date().toISOString(),
          gapMinutes: Math.round(gap / 60000),
          message: `Extension was disabled for ~${Math.round(gap / 60000)} minutes`,
        }),
      }).catch(() => {});
    }

    // Force re-enable protection
    const timer = await getTimer();
    timer.enabled = true;
    timer.sessionActive = false;
    timer.isPaused = false;
    await setTimer(timer);
  }
}

// ── Tab monitoring ────────────────────────────────────────
// Detect when user opens chrome://extensions or settings while locked

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  const url = changeInfo.url;
  const isExtPage = (
    url.startsWith("chrome://extensions") ||
    url.startsWith("chrome://settings") ||
    url.startsWith("edge://extensions") ||
    url.startsWith("brave://extensions") ||
    url.startsWith("about:addons")
  );
  if (!isExtPage) return;

  const c = await getCommitment();
  if (!c.locked) return;

  const timer = await getTimer();
  const isActive = timer.sessionActive && !timer.isPaused && timer.secondsUsed < timer.dailyLimitSeconds;

  if (c.webhookUrl) {
    fetch(c.webhookUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "extensions_page_opened", ts: new Date().toISOString(),
        message: "User opened browser extensions page while session was inactive",
      }),
    }).catch(() => {});
  }

  if (!isActive) {
    try {
      chrome.windows.create({
        url: chrome.runtime.getURL("escape.html"),
        type: "popup",
        width: 480,
        height: 560,
        focused: true,
      });
    } catch (_) {}

    if (c.webhookUrl) {
      fetch(c.webhookUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "escape_interrupt_shown", ts: new Date().toISOString() }),
      }).catch(() => {});
    }

    try { chrome.tabs.remove(tabId); } catch (_) {}
  }
});

// ── Daily Reset ───────────────────────────────────────────

async function checkDailyReset() {
  const timer = await getTimer();
  const today = new Date().toISOString().split("T")[0];
  if (timer.lastResetDate !== today) {
    const c = await getCommitment();
    c.dailyLog.push({ date: timer.lastResetDate, used: timer.secondsUsed, limit: timer.dailyLimitSeconds });
    if (c.dailyLog.length > 30) c.dailyLog = c.dailyLog.slice(-30);
    await setCommitment(c);

    const p = await getPlatforms();
    for (const k in p) p[k].secondsUsed = 0;
    await setPlatforms(p);

    timer.secondsUsed = 0; timer.sessionActive = false; timer.isPaused = false;
    timer.lastResetDate = today; timer.lastTickAt = null;
    await setTimer(timer);

    const meta = await getMeta();
    meta.totalDaysUsed++;
    const recentTamper = meta.disableEvents.some(e => e.timestamp > Date.now() - 86400000);
    if (!recentTamper) { meta.streakDays++; }
    else { meta.streakDays = 1; meta.streakStartDate = today; }
    await setMeta(meta);
  }
}

// ── Tick ──────────────────────────────────────────────────

let warned5 = false, warned1 = false;

async function tick() {
  await checkDailyReset();
  const timer = await getTimer();

  // Alive timestamp for tamper detection
  const meta = await getMeta();
  meta.lastAliveTimestamp = Date.now();
  await setMeta(meta);

  if (!timer.enabled || !timer.sessionActive || timer.isPaused) {
    // Keep lastTickAt current so we don't accumulate phantom time on resume
    timer.lastTickAt = Date.now();
    await setTimer(timer);
    return;
  }

  if (timer.secondsUsed >= timer.dailyLimitSeconds) {
    timer.sessionActive = false; timer.isPaused = false; timer.lastTickAt = null;
    await setTimer(timer);
    broadcast({ type: "TIME_EXPIRED", timer });
    warned5 = false; warned1 = false;
    return;
  }

  const platform = await getActivePlatform();
  if (!platform) {
    timer.lastTickAt = Date.now();
    await setTimer(timer);
    return;
  }

  // Delta-time: compute real elapsed seconds since last tick
  const now = Date.now();
  const lastTick = timer.lastTickAt || now;
  const rawDelta = Math.floor((now - lastTick) / 1000);
  const deltaSeconds = Math.min(Math.max(rawDelta, 0), 120); // clamp [0..120]

  const remBefore = timer.dailyLimitSeconds - timer.secondsUsed;
  const add = Math.min(deltaSeconds, remBefore);
  timer.secondsUsed += add;
  timer.lastTickAt = now;
  await setTimer(timer);

  const platforms = await getPlatforms();
  if (platforms[platform]) {
    platforms[platform].secondsUsed = Math.min(
      platforms[platform].secondsUsed + add,
      timer.dailyLimitSeconds
    );
    await setPlatforms(platforms);
  }

  const rem = timer.dailyLimitSeconds - timer.secondsUsed;

  // Threshold warnings — fire when remaining crosses below threshold (works with large deltas)
  if (rem <= 300 && remBefore > 300 && !warned5) { warned5 = true; broadcast({ type: "FIVE_MIN_WARNING", timer }); }
  if (rem <= 60 && remBefore > 60 && !warned1) { warned1 = true; broadcast({ type: "ONE_MIN_WARNING", timer }); }

  if (rem <= 0) {
    timer.sessionActive = false; timer.isPaused = false; timer.lastTickAt = null;
    await setTimer(timer);
    broadcast({ type: "TIME_EXPIRED", timer });
    warned5 = false; warned1 = false;
    return;
  }

  broadcast({ type: "STATE_UPDATE", timer, platforms });
}

async function getActivePlatform() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    return DOMAINS[new URL(tab.url).hostname] || null;
  } catch { return null; }
}

// ── Broadcast ─────────────────────────────────────────────

async function broadcast(msg) {
  const patterns = Object.keys(DOMAINS).map(d => `*://${d}/*`);
  try {
    const tabs = await chrome.tabs.query({ url: patterns });
    for (const t of tabs) { try { chrome.tabs.sendMessage(t.id, msg); } catch {} }
  } catch {}
}

// ── Hashing ───────────────────────────────────────────────

async function hashPass(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Heartbeat ─────────────────────────────────────────────

async function heartbeat() {
  const c = await getCommitment();
  c.lastHeartbeat = Date.now();
  await setCommitment(c);
  if (c.webhookUrl) {
    const timer = await getTimer();
    const meta = await getMeta();
    fetch(c.webhookUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "heartbeat", ts: new Date().toISOString(),
        used: timer.secondsUsed, limit: timer.dailyLimitSeconds,
        enabled: timer.enabled, streakDays: meta.streakDays,
        tamperEvents: meta.disableEvents.length,
      }),
    }).catch(() => {});
  }
}

// ── Messages ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  (async () => {
    const timer = await getTimer();
    const platforms = await getPlatforms();

    switch (msg.type) {

      // ── State ────────────────────────────────────────────
      case "GET_STATE": {
        const c = await getCommitment();
        const meta = await getMeta();
        respond({
          timer, platforms,
          commitment: {
            locked: c.locked,
            pendingDisable: c.pendingDisable, webhookUrl: !!c.webhookUrl,
            deterrenceLevel: c.deterrenceLevel || "off",
          },
          antiCircumvention: {
            streakDays: meta.streakDays, totalDaysUsed: meta.totalDaysUsed,
            disableEvents: meta.disableEvents.length,
          },
        });
        break;
      }

      // ── Setup ────────────────────────────────────────────
      case "GET_SETUP_STATUS": {
        const meta = await getMeta();
        respond({ needsSetup: !meta.setupDone });
        break;
      }

      case "MARK_SETUP_DONE": {
        const meta = await getMeta();
        meta.setupDone = true;
        await setMeta(meta);
        respond({ success: true });
        break;
      }

      // ── Passphrase verification ──────────────────────────
      case "VERIFY_PASSPHRASE": {
        const c = await getCommitment();
        if (!c.locked || !c.passphraseHash) { respond({ valid: true }); break; }
        const hash = await hashPass(msg.passphrase);
        const valid = hash === c.passphraseHash;
        if (!valid) {
          if (c.webhookUrl) {
            fetch(c.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ event: "unlock_attempt_failed", ts: new Date().toISOString() }) }).catch(() => {});
          }
          const deterMsg = getDeterrenceMessage(c.deterrenceLevel || "off");
          respond({ valid: false, deterrenceMessage: deterMsg });
        } else {
          respond({ valid: true });
        }
        break;
      }

      // ── Session controls ────────────────────────────────
      case "START_SESSION": {
        if (timer.secondsUsed >= timer.dailyLimitSeconds) { respond({ success: false }); break; }
        timer.sessionActive = true; timer.isPaused = false;
        timer.lastTickAt = Date.now();
        warned5 = false; warned1 = false;
        await setTimer(timer);
        broadcast({ type: "SESSION_STARTED", timer, platforms });
        respond({ success: true, timer });
        break;
      }

      case "PAUSE_SESSION": {
        timer.isPaused = true;
        timer.lastTickAt = Date.now();
        await setTimer(timer);
        broadcast({ type: "SESSION_PAUSED", timer, platforms });
        respond({ success: true, timer });
        break;
      }

      case "RESUME_SESSION": {
        if (timer.secondsUsed >= timer.dailyLimitSeconds) { respond({ success: false }); break; }
        timer.isPaused = false; timer.sessionActive = true;
        timer.lastTickAt = Date.now();
        await setTimer(timer);
        broadcast({ type: "SESSION_RESUMED", timer, platforms });
        respond({ success: true, timer });
        break;
      }

      case "STOP_SESSION": {
        timer.sessionActive = false; timer.isPaused = false;
        timer.lastTickAt = null;
        await setTimer(timer);
        broadcast({ type: "SESSION_STOPPED", timer, platforms });
        respond({ success: true, timer });
        break;
      }

      // ── Settings ────────────────────────────────────────
      case "UPDATE_SETTINGS": {
        const c = await getCommitment();
        const isActive = timer.sessionActive && !timer.isPaused && timer.secondsUsed < timer.dailyLimitSeconds;

        if (c.locked) {
          // Block daily limit changes outside active session
          if (msg.settings.dailyLimitSeconds !== undefined && msg.settings.dailyLimitSeconds !== timer.dailyLimitSeconds && !isActive) {
            respond({ success: false, reason: "commitment_locked" }); break;
          }
          // Block disabling outside active session — hard block, no cooldown
          if (msg.settings.enabled === false && !isActive) {
            if (c.webhookUrl) {
              fetch(c.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ event: "disable_attempted", ts: new Date().toISOString() }) }).catch(() => {});
            }
            const deterMsg = getDeterrenceMessage(c.deterrenceLevel || "off");
            respond({ success: false, reason: "locked_outside_session", deterrenceMessage: deterMsg }); break;
          }
        }

        if (msg.settings.dailyLimitSeconds) timer.dailyLimitSeconds = msg.settings.dailyLimitSeconds;
        if (msg.settings.enabled !== undefined) timer.enabled = msg.settings.enabled;
        await setTimer(timer);
        broadcast({ type: "SETTINGS_UPDATED", timer, platforms });
        respond({ success: true, timer, platforms });
        break;
      }

      // ── Commitment Lock ─────────────────────────────────
      case "ENABLE_COMMITMENT": {
        const hash = await hashPass(msg.passphrase);
        const c2 = await getCommitment();
        c2.locked = true; c2.passphraseHash = hash; c2.lockedAt = Date.now();
        if (msg.webhookUrl) c2.webhookUrl = msg.webhookUrl;
        await setCommitment(c2);
        if (c2.webhookUrl) {
          fetch(c2.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event: "commitment_activated", ts: new Date().toISOString() }) }).catch(() => {});
        }
        respond({ success: true });
        break;
      }

      case "DISABLE_COMMITMENT": {
        const c3 = await getCommitment();
        const hash2 = await hashPass(msg.passphrase);
        if (c3.passphraseHash && hash2 !== c3.passphraseHash) {
          if (c3.webhookUrl) {
            fetch(c3.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ event: "unlock_failed", ts: new Date().toISOString() }) }).catch(() => {});
          }
          const deterMsg = getDeterrenceMessage(c3.deterrenceLevel || "off");
          respond({ success: false, reason: "wrong_passphrase", deterrenceMessage: deterMsg }); break;
        }
        c3.locked = false; c3.passphraseHash = null; c3.pendingDisable = null;
        await setCommitment(c3);
        respond({ success: true });
        break;
      }

      case "GET_LOG": {
        const c6 = await getCommitment();
        const meta = await getMeta();
        respond({
          log: c6.dailyLog,
          today: { date: timer.lastResetDate, used: timer.secondsUsed, limit: timer.dailyLimitSeconds },
          streak: meta.streakDays, totalDays: meta.totalDaysUsed, tamperEvents: meta.disableEvents,
        });
        break;
      }

      // ── Deterrence settings ──────────────────────────────
      case "SET_DETERRENCE": {
        const c7 = await getCommitment();
        const level = msg.level;
        if (!["off","firm","hard"].includes(level)) { respond({ success: false }); break; }
        c7.deterrenceLevel = level;
        await setCommitment(c7);
        respond({ success: true });
        break;
      }

      default: respond({ error: "unknown" });
    }
  })();
  return true;
});

// ── Alarms ────────────────────────────────────────────────

chrome.alarms.create("fs_tick", { periodInMinutes: 0.5 });
chrome.alarms.create("fs_reset", { periodInMinutes: 1 });
chrome.alarms.create("fs_heartbeat", { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === "fs_tick") tick();
  if (a.name === "fs_reset") checkDailyReset();
  if (a.name === "fs_heartbeat") heartbeat();
});

checkDailyReset();
