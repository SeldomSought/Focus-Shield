/*
 * Focus Shield — Popup (v2)
 *
 * UI STATES:
 *   1. SETUP     — No passphrase set yet. Shows onboarding screen.
 *   2. LOCKED    — Passphrase active. Timer + session controls visible.
 *                  Settings/master toggle HIDDEN behind passphrase gate.
 *   3. UNLOCKED  — Passphrase entered or no commitment lock. Full access.
 *   4. SESSION   — Active session. Timer controls visible. Settings accessible
 *                  (user earned their freedom minutes, let them tweak things).
 *
 * KEY RULE: You can only disable/modify the extension if:
 *   a) You have the accountability partner's passphrase, OR
 *   b) You are in an active session (within your daily window)
 */

const LIMITS = [
  { label: "5m", val: 300 }, { label: "10m", val: 600 }, { label: "15m", val: 900 },
  { label: "20m", val: 1200 }, { label: "30m", val: 1800 },
  { label: "45m", val: 2700 }, { label: "60m", val: 3600 },
];

function showDeterrenceMessage(msg) {
  if (!msg) return;
  let el = $("deterrenceMsg");
  if (!el) return;
  el.textContent = msg;
  el.style.display = "block";
  setTimeout(() => { el.style.display = "none"; }, 7000);
}

const $ = id => document.getElementById(id);
const CIRC = 251.3;

let state = null;
let settingsUnlocked = false;  // whether the passphrase gate has been passed

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════

chrome.runtime.sendMessage({ type: "GET_STATE" }, (r) => {
  if (!r) return;
  state = r;
  decideScreen();
});

function decideScreen() {
  const c = state.commitment;
  const t = state.timer;
  const isActive = t.sessionActive && !t.isPaused && t.secondsUsed < t.dailyLimitSeconds;

  // Show tamper warnings
  if (state.antiCircumvention?.disableEvents > 0) {
    $("tamperWarn").style.display = "block";
    $("tamperDuration").textContent = `${state.antiCircumvention.disableEvents} time(s)`;
  }

  // Show streak
  if (state.antiCircumvention?.streakDays > 0) {
    $("hdrStreak").textContent = `🔥 ${state.antiCircumvention.streakDays}d streak`;
  }

  // Determine which screen to show
  if (!c.locked) {
    // No commitment lock — check if this is first install (show setup)
    chrome.runtime.sendMessage({ type: "GET_SETUP_STATUS" }, (r2) => {
      if (r2?.needsSetup) {
        showSetup();
      } else {
        // Commitment not active but user skipped setup — show full UI
        settingsUnlocked = true;
        showMain();
      }
    });
  } else if (isActive) {
    // Active session — settings accessible (you earned it)
    settingsUnlocked = true;
    showMain();
  } else {
    // Locked & no active session — show gate
    settingsUnlocked = false;
    showMain();
  }
}

// ═══════════════════════════════════════════════════════════════
// SETUP SCREEN
// ═══════════════════════════════════════════════════════════════

function showSetup() {
  $("setupScreen").style.display = "block";
  $("mainContent").style.display = "none";
}

$("setupBtn").addEventListener("click", () => {
  const p1 = $("setupPass").value;
  const p2 = $("setupPass2").value;
  const wh = $("setupWebhook").value.trim();

  if (!p1 || p1.length < 4) {
    $("setupErr").innerHTML = '<div class="err">Passphrase must be 4+ characters</div>';
    return;
  }
  if (p1 !== p2) {
    $("setupErr").innerHTML = '<div class="err">Passphrases don\'t match</div>';
    return;
  }

  chrome.runtime.sendMessage({
    type: "ENABLE_COMMITMENT",
    passphrase: p1,
    webhookUrl: wh || null,
  }, (r) => {
    if (r?.success) {
      chrome.runtime.sendMessage({ type: "MARK_SETUP_DONE" });
      // Reload state
      chrome.runtime.sendMessage({ type: "GET_STATE" }, (r2) => {
        state = r2;
        settingsUnlocked = false;
        $("setupScreen").style.display = "none";
        showMain();
      });
    }
  });
});

$("setupSkip").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "MARK_SETUP_DONE" });
  settingsUnlocked = true;
  $("setupScreen").style.display = "none";
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (r) => {
    state = r;
    showMain();
  });
});

// ═══════════════════════════════════════════════════════════════
// MAIN INTERFACE
// ═══════════════════════════════════════════════════════════════

function showMain() {
  $("mainContent").style.display = "block";

  const isLocked = state.commitment?.locked;
  const t = state.timer;
  const isActive = t.sessionActive && !t.isPaused && t.secondsUsed < t.dailyLimitSeconds;

  // Show/hide settings area and gate
  if (isLocked && !settingsUnlocked && !isActive) {
    $("settingsArea").style.display = "none";
    $("unlockGate").style.display = "block";
  } else {
    $("settingsArea").style.display = "block";
    $("unlockGate").style.display = "none";
  }

  render();
  buildChips();
  buildLockUI();
}

// ═══════════════════════════════════════════════════════════════
// PASSPHRASE GATE
// ═══════════════════════════════════════════════════════════════

$("gateBtn").addEventListener("click", () => {
  const pass = $("gatePass").value;
  if (!pass) {
    $("gateErr").innerHTML = '<div class="err">Enter the passphrase</div>';
    return;
  }

  chrome.runtime.sendMessage({ type: "VERIFY_PASSPHRASE", passphrase: pass }, (r) => {
    if (r?.valid) {
      settingsUnlocked = true;
      $("unlockGate").style.display = "none";
      $("settingsArea").style.display = "block";
      $("gatePass").value = "";
      $("gateErr").innerHTML = "";
    } else {
      $("gateErr").innerHTML = '<div class="err">Wrong passphrase. Attempt logged.</div>';
      if (r?.deterrenceMessage) showDeterrenceMessage(r.deterrenceMessage);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// SESSION CONTROLS (always accessible — no passphrase needed)
// ═══════════════════════════════════════════════════════════════

$("bStart").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "START_SESSION" }, (r) => {
    if (r?.success) { state.timer = r.timer; render(); decideScreen(); }
  });
});

$("bPause").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "PAUSE_SESSION" }, (r) => {
    if (r?.success) { state.timer = r.timer; render(); }
  });
});

$("bStop").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP_SESSION" }, (r) => {
    if (r?.success) {
      state.timer = r.timer;
      settingsUnlocked = false;  // re-lock settings when session stops
      render();
      decideScreen();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// MASTER TOGGLE (requires unlocked state)
// ═══════════════════════════════════════════════════════════════

$("master").addEventListener("change", (e) => {
  const isLocked = state.commitment?.locked;
  const isActive = state.timer.sessionActive && !state.timer.isPaused;

  // Double-check: only allow if unlocked or in active session
  if (isLocked && !settingsUnlocked && !isActive) {
    e.target.checked = true;
    return;
  }

  chrome.runtime.sendMessage({ type: "UPDATE_SETTINGS", settings: { enabled: e.target.checked } }, (r) => {
    if (r?.success) { state.timer = r.timer; render(); }
    else if (r?.reason === "commitment_locked") {
      e.target.checked = true;
    }
    else if (r?.reason === "locked_outside_session") {
      e.target.checked = true;
      showDeterrenceMessage(r.deterrenceMessage ||
        "Protection is active. Start a session or use your passphrase to make changes.");
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════════

function render() {
  const t = state.timer;
  const rem = Math.max(0, t.dailyLimitSeconds - t.secondsUsed);
  const pct = t.secondsUsed / t.dailyLimitSeconds;
  const expired = rem <= 0;
  const active = t.sessionActive && !t.isPaused && !expired;
  const paused = t.sessionActive && t.isPaused;

  // Ring
  const ring = $("ring");
  ring.style.strokeDashoffset = (pct * CIRC).toString();
  ring.style.stroke = pct > 0.9 ? "#f4212e" : pct > 0.7 ? "#ffa500" : "#4ade80";

  // Digits
  const m = Math.floor(rem / 60), s = rem % 60;
  $("digits").textContent = `${m}:${s.toString().padStart(2, "0")}`;
  $("digits").style.color = expired ? "#f4212e" : "#e7e9ea";

  // Status
  const isLocked = state.commitment?.locked;
  $("status").textContent = expired ? "Daily limit reached — resets at midnight" :
    active ? `Session active — ${m}m ${s}s remaining` :
    paused ? "Paused — tap play to resume" :
    !t.enabled ? "Focus Shield disabled" :
    isLocked ? "🔒 Feeds locked — protection active" :
    "Feeds locked — start a session to browse";

  // Buttons
  if (expired) {
    $("bStart").style.display = "none"; $("bPause").style.display = "none"; $("bStop").style.display = "none";
  } else if (active) {
    $("bStart").style.display = "none"; $("bPause").style.display = ""; $("bStop").style.display = "";
  } else if (paused) {
    $("bStart").style.display = ""; $("bStart").textContent = "▶ Resume";
    $("bStart").onclick = () => chrome.runtime.sendMessage({ type: "RESUME_SESSION" }, (r) => {
      if (r?.success) { state.timer = r.timer; render(); decideScreen(); }
    });
    $("bPause").style.display = "none"; $("bStop").style.display = "";
  } else {
    $("bStart").style.display = ""; $("bStart").textContent = "▶ Start";
    $("bStart").onclick = () => chrome.runtime.sendMessage({ type: "START_SESSION" }, (r) => {
      if (r?.success) { state.timer = r.timer; render(); decideScreen(); }
    });
    $("bPause").style.display = "none"; $("bStop").style.display = "none";
  }

  // Master toggle
  $("master").checked = t.enabled;

  // Header dot color
  $("hdrDot").style.background = expired ? "#f4212e" : active ? "#4ade80" : paused ? "#ffa500" : "#71767b";
}

// ═══════════════════════════════════════════════════════════════
// LIMIT CHIPS
// ═══════════════════════════════════════════════════════════════

function buildChips() {
  const wrap = $("chips");
  wrap.innerHTML = "";
  LIMITS.forEach(l => {
    const btn = document.createElement("button");
    btn.className = `chip${state.timer.dailyLimitSeconds === l.val ? " on" : ""}`;
    btn.textContent = l.label;
    btn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "UPDATE_SETTINGS", settings: { dailyLimitSeconds: l.val } }, (r) => {
        if (r?.success) { state.timer = r.timer; render(); buildChips(); }
        else if (r?.reason === "commitment_locked") {
          // Only allow during active session
          const isActive = state.timer.sessionActive && !state.timer.isPaused;
          if (!settingsUnlocked && !isActive) return;
        }
      });
    });
    wrap.appendChild(btn);
  });
}

// ═══════════════════════════════════════════════════════════════
// COMMITMENT LOCK UI
// ═══════════════════════════════════════════════════════════════

function buildLockUI() {
  const c = state.commitment;
  const badge = $("lockBadge");
  const ui = $("lockUI");

  if (c.locked) {
    badge.className = "badge badge-on";
    badge.textContent = "ACTIVE";

    const deterLevel = state.commitment?.deterrenceLevel || "off";
    let html = `<p class="info">🔒 Protection active. Settings require the passphrase or an active session.</p>
      <div class="row" style="margin-top:6px">
        <div><div class="row-label" style="font-size:11px">Coach messages</div><div class="row-sub">Shown on failed disable attempts</div></div>
        <select id="deterrenceSelect" class="inp" style="width:auto;padding:4px 6px;margin:0">
          <option value="off"${deterLevel==="off"?" selected":""}>Off</option>
          <option value="firm"${deterLevel==="firm"?" selected":""}>Firm</option>
          <option value="hard"${deterLevel==="hard"?" selected":""}>Hard</option>
        </select>
      </div>`;

    if (c.pendingDisable) {
      html += `<div class="cooldown"><p>⏳ Disable request pending. Cooldown: ${c.cooldownMinutes} min.</p>
        <button id="checkCooldown" class="lbtn lbtn-off" style="margin-top:4px">Check Status</button></div>`;
    }

    html += `<input type="password" class="inp" id="unlockPass" placeholder="Enter passphrase to remove lock">
      <button id="unlockBtn" class="lbtn lbtn-off">🔓 Remove Commitment Lock</button>
      <div id="lockErr"></div>`;

    if (c.webhookUrl) {
      html += `<p class="info">🔔 Webhook active. Heartbeat every 5 min. Tampering is detected and reported.</p>`;
    }

    ui.innerHTML = html;

    $("unlockBtn").addEventListener("click", () => {
      const pass = $("unlockPass").value;
      if (!pass) { $("lockErr").innerHTML = '<div class="err">Enter passphrase</div>'; return; }
      chrome.runtime.sendMessage({ type: "DISABLE_COMMITMENT", passphrase: pass }, (r) => {
        if (r?.success) {
          state.commitment.locked = false;
          settingsUnlocked = true;
          buildLockUI();
        } else {
          $("lockErr").innerHTML = '<div class="err">Wrong passphrase. Attempt logged & reported.</div>';
          if (r?.deterrenceMessage) showDeterrenceMessage(r.deterrenceMessage);
        }
      });
    });

    if ($("deterrenceSelect")) {
      $("deterrenceSelect").addEventListener("change", (e) => {
        chrome.runtime.sendMessage({ type: "SET_DETERRENCE", level: e.target.value });
        if (state.commitment) state.commitment.deterrenceLevel = e.target.value;
      });
    }

    if (c.pendingDisable && $("checkCooldown")) {
      $("checkCooldown").addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "CHECK_PENDING" }, (r) => {
          if (r?.ready) { state.timer = r.timer; render(); }
          else if (r?.minutesLeft) { $("status").textContent = `${r.minutesLeft} min remaining in cooldown`; }
          else { $("status").textContent = "No pending disable request"; }
        });
      });
    }
  } else {
    badge.className = "badge badge-off";
    badge.textContent = "OFF";

    ui.innerHTML = `
      <p class="info" style="margin-bottom:6px">Have your accountability partner set a passphrase to lock settings.</p>
      <input type="password" class="inp" id="lockPass" placeholder="Partner: passphrase (4+ chars)">
      <input type="password" class="inp" id="lockPass2" placeholder="Partner: confirm passphrase">
      <input type="url" class="inp" id="webhookUrl" placeholder="Webhook URL (optional)">
      <button id="lockBtn" class="lbtn lbtn-on">🔒 Activate Commitment Lock</button>
      <div id="lockErr"></div>
    `;

    $("lockBtn").addEventListener("click", () => {
      const p1 = $("lockPass").value, p2 = $("lockPass2").value;
      const wh = $("webhookUrl").value.trim();
      if (!p1 || p1.length < 4) { $("lockErr").innerHTML = '<div class="err">Passphrase must be 4+ chars</div>'; return; }
      if (p1 !== p2) { $("lockErr").innerHTML = '<div class="err">Passphrases don\'t match</div>'; return; }
      chrome.runtime.sendMessage({ type: "ENABLE_COMMITMENT", passphrase: p1, webhookUrl: wh || null }, (r) => {
        if (r?.success) {
          state.commitment.locked = true;
          state.commitment.webhookUrl = !!wh;
          settingsUnlocked = false;
          buildLockUI();
          decideScreen();
        }
      });
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// AUTO-REFRESH
// ═══════════════════════════════════════════════════════════════

setInterval(() => {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (r) => {
    if (r) {
      const wasActive = state?.timer?.sessionActive && !state?.timer?.isPaused;
      state = r;
      render();

      // If session just ended, re-lock
      const isActive = r.timer.sessionActive && !r.timer.isPaused;
      if (wasActive && !isActive) {
        settingsUnlocked = false;
        decideScreen();
      }
    }
  });
}, 1000);
