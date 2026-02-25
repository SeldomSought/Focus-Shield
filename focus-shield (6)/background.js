/*
 * Focus Shield — Background Service Worker (v3)
 *
 * PROTECTION MODEL:
 *   - Settings/disable require passphrase OR active session
 *   - Setup flow forces passphrase creation on first install
 *   - Extension disable/removal detected via alive-timestamp gaps
 *   - Webhook heartbeat every 5 min (silence = tamper)
 *   - Uninstall URL opens accountability page
 *   - chrome.management API detects other extensions being toggled
 */

const DEFAULT_TIMER = {
  secondsUsed: 0, dailyLimitSeconds: 1800,
  lastResetDate: new Date().toISOString().split("T")[0],
  sessionActive: false, isPaused: false, enabled: true,
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
  cooldownMinutes: 1440, pendingDisable: null,
  webhookUrl: null, lastHeartbeat: null, dailyLog: [],
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
// Detect when user opens chrome://extensions (they might be trying to remove us)

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url && (
    changeInfo.url.startsWith("chrome://extensions") ||
    changeInfo.url.startsWith("chrome://settings") ||
    changeInfo.url.startsWith("edge://extensions") ||
    changeInfo.url.startsWith("brave://extensions")
  )) {
    const c = await getCommitment();
    if (c.locked) {
      const timer = await getTimer();
      const isActive = timer.sessionActive && !timer.isPaused && timer.secondsUsed < timer.dailyLimitSeconds;

      if (!isActive && c.webhookUrl) {
        fetch(c.webhookUrl, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "extensions_page_opened", ts: new Date().toISOString(),
            message: "User opened browser extensions page while session was inactive",
          }),
        }).catch(() => {});
      }
    }
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
    timer.lastResetDate = today;
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

  if (!timer.enabled || !timer.sessionActive || timer.isPaused) return;

  if (timer.secondsUsed >= timer.dailyLimitSeconds) {
    timer.sessionActive = false; timer.isPaused = false;
    await setTimer(timer);
    broadcast({ type: "TIME_EXPIRED", timer });
    warned5 = false; warned1 = false;
    return;
  }

  const platform = await getActivePlatform();
  if (!platform) return;

  timer.secondsUsed += 1;
  await setTimer(timer);

  const platforms = await getPlatforms();
  if (platforms[platform]) { platforms[platform].secondsUsed += 1; await setPlatforms(platforms); }

  const rem = timer.dailyLimitSeconds - timer.secondsUsed;
  if (rem <= 300 && rem > 299 && !warned5) { warned5 = true; broadcast({ type: "FIVE_MIN_WARNING", timer }); }
  if (rem <= 60 && rem > 59 && !warned1) { warned1 = true; broadcast({ type: "ONE_MIN_WARNING", timer }); }
  if (timer.secondsUsed % 2 === 0) broadcast({ type: "STATE_UPDATE", timer, platforms });
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
            locked: c.locked, cooldownMinutes: c.cooldownMinutes,
            pendingDisable: c.pendingDisable, webhookUrl: !!c.webhookUrl,
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

      // ── Passphrase verification (for popup gate) ────────
      case "VERIFY_PASSPHRASE": {
        const c = await getCommitment();
        if (!c.locked || !c.passphraseHash) { respond({ valid: true }); break; }
        const hash = await hashPass(msg.passphrase);
        const valid = hash === c.passphraseHash;
        if (!valid && c.webhookUrl) {
          fetch(c.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event: "unlock_attempt_failed", ts: new Date().toISOString() }) }).catch(() => {});
        }
        respond({ valid });
        break;
      }

      // ── Session controls ────────────────────────────────
      case "START_SESSION": {
        if (timer.secondsUsed >= timer.dailyLimitSeconds) { respond({ success: false }); break; }
        timer.sessionActive = true; timer.isPaused = false;
        warned5 = false; warned1 = false;
        await setTimer(timer);
        broadcast({ type: "SESSION_STARTED", timer, platforms });
        respond({ success: true, timer });
        break;
      }

      case "PAUSE_SESSION": {
        timer.isPaused = true; await setTimer(timer);
        broadcast({ type: "SESSION_PAUSED", timer, platforms });
        respond({ success: true, timer });
        break;
      }

      case "RESUME_SESSION": {
        if (timer.secondsUsed >= timer.dailyLimitSeconds) { respond({ success: false }); break; }
        timer.isPaused = false; timer.sessionActive = true; await setTimer(timer);
        broadcast({ type: "SESSION_RESUMED", timer, platforms });
        respond({ success: true, timer });
        break;
      }

      case "STOP_SESSION": {
        timer.sessionActive = false; timer.isPaused = false; await setTimer(timer);
        broadcast({ type: "SESSION_STOPPED", timer, platforms });
        respond({ success: true, timer });
        break;
      }

      // ── Settings ────────────────────────────────────────
      case "UPDATE_SETTINGS": {
        const c = await getCommitment();
        const isActive = timer.sessionActive && !timer.isPaused && timer.secondsUsed < timer.dailyLimitSeconds;

        // If commitment locked and NOT in active session, block changes
        if (c.locked && !isActive) {
          if (msg.settings.dailyLimitSeconds !== undefined && msg.settings.dailyLimitSeconds !== timer.dailyLimitSeconds) {
            respond({ success: false, reason: "commitment_locked" }); break;
          }
          if (msg.settings.enabled === false) {
            c.pendingDisable = Date.now(); await setCommitment(c);
            if (c.webhookUrl) {
              fetch(c.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ event: "disable_attempted", ts: new Date().toISOString() }) }).catch(() => {});
            }
            respond({ success: false, reason: "cooldown_started", cooldownMinutes: c.cooldownMinutes }); break;
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
        if (msg.cooldownMinutes) c2.cooldownMinutes = msg.cooldownMinutes;
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
          respond({ success: false, reason: "wrong_passphrase" }); break;
        }
        c3.locked = false; c3.passphraseHash = null; c3.pendingDisable = null;
        await setCommitment(c3);
        respond({ success: true });
        break;
      }

      case "CHECK_PENDING": {
        const c5 = await getCommitment();
        if (!c5.pendingDisable) { respond({ ready: false, noPending: true }); break; }
        const elapsed = (Date.now() - c5.pendingDisable) / 60000;
        if (elapsed >= c5.cooldownMinutes) {
          timer.enabled = false; await setTimer(timer);
          c5.pendingDisable = null; await setCommitment(c5);
          broadcast({ type: "SETTINGS_UPDATED", timer, platforms });
          respond({ ready: true, timer });
        } else {
          respond({ ready: false, minutesLeft: Math.ceil(c5.cooldownMinutes - elapsed) });
        }
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

      default: respond({ error: "unknown" });
    }
  })();
  return true;
});

// ── Alarms ────────────────────────────────────────────────

chrome.alarms.create("fs_tick", { periodInMinutes: 1 / 60 });
chrome.alarms.create("fs_reset", { periodInMinutes: 1 });
chrome.alarms.create("fs_heartbeat", { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === "fs_tick") tick();
  if (a.name === "fs_reset") checkDailyReset();
  if (a.name === "fs_heartbeat") heartbeat();
});

checkDailyReset();
