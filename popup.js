/*
 * Focus Shield — Popup v3
 */

const LIMIT_OPTIONS = [5, 10, 15, 20, 30, 45, 60];

let _state = null;

function fmt(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function calcRemaining(state) {
  if (!state.sessionActive || !state.sessionStartedAt) return state.remainingSeconds;
  const elapsed = Math.floor((Date.now() - state.sessionStartedAt) / 1000);
  return Math.max(0, state.remainingSeconds - elapsed);
}

function isSessionLive(state) {
  return state.sessionActive && calcRemaining(state) > 0;
}

function render(state) {
  _state = state;

  const remaining = calcRemaining(state);
  const live = isSessionLive(state);
  const expired = remaining <= 0;

  // Time display
  document.getElementById("timeDisplay").textContent = fmt(remaining);

  // Status text
  let status;
  if (!state.focusEnabled) {
    status = "Shield disabled — all sites allowed.";
  } else if (expired) {
    status = "Daily budget exhausted. Resets at midnight.";
  } else if (live) {
    status = "Free scrolling session active.";
  } else {
    status = "Shield active. Feeds blocked.";
  }
  document.getElementById("statusText").textContent = status;

  // Header dot
  const dot = document.getElementById("hdrDot");
  dot.style.background = !state.focusEnabled ? "#536471"
    : expired ? "#f4212e"
    : live ? "#4ade80"
    : "#71767b";

  // Buttons
  const btnStart = document.getElementById("btnStart");
  const btnStop  = document.getElementById("btnStop");

  if (!state.focusEnabled || expired) {
    btnStart.style.display = "";
    btnStart.textContent = "▶ Start Session";
    btnStart.disabled = true;
    btnStop.style.display = "none";
  } else if (live) {
    btnStart.style.display = "none";
    btnStop.style.display = "";
    btnStop.disabled = false;
  } else {
    btnStart.style.display = "";
    btnStart.textContent = "▶ Start Session";
    btnStart.disabled = false;
    btnStop.style.display = "none";
  }

  // Focus toggle
  document.getElementById("toggleFocus").checked = state.focusEnabled;

  // Limit chips
  const chips = document.getElementById("limitChips");
  chips.innerHTML = "";
  LIMIT_OPTIONS.forEach(mins => {
    const el = document.createElement("button");
    el.className = "chip" + (state.dailyLimitMinutes === mins ? " on" : "");
    el.textContent = mins + "m";
    el.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "SET_LIMIT", minutes: mins }, () => {
        refreshState();
      });
    });
    chips.appendChild(el);
  });
}

function refreshState() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
    if (chrome.runtime.lastError || !state) return;
    render(state);
  });
}

// ── Event listeners ───────────────────────────────────────────

document.getElementById("btnStart").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "START_SESSION" }, () => refreshState());
});

document.getElementById("btnStop").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP_SESSION" }, () => refreshState());
});

document.getElementById("toggleFocus").addEventListener("change", (e) => {
  chrome.runtime.sendMessage({ type: "SET_FOCUS_ENABLED", enabled: e.target.checked }, () => refreshState());
});

document.getElementById("btnReset").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "RESET_TODAY" }, () => refreshState());
});

// ── Auto-refresh while popup is open ─────────────────────────

setInterval(refreshState, 1000);

// ── Init ─────────────────────────────────────────────────────

refreshState();
