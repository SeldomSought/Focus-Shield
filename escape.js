/* Focus Shield — Escape Interrupt (Prompt 5) */

const $ = id => document.getElementById(id);

// ── State ──────────────────────────────────────────────────

function fmt(s) {
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, "0")}`;
}

function loadState() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, r => {
    if (!r) return;
    const t = r.timer;
    const rem = Math.max(0, t.dailyLimitSeconds - t.secondsUsed);
    $("remainingTime").textContent = rem <= 0 ? "None — limit reached" : fmt(rem);
    if (rem <= 0) {
      $("startSessionBtn").disabled = true;
      $("startSessionBtn").textContent = "Daily limit reached";
    }
  });
}

loadState();

// ── 30-second countdown before unlock button is enabled ──

let countdown = 30;
const countdownSec = $("countdownSec");
const unlockBtn = $("unlockBtn");
const countdownNote = $("countdownNote");

const timer = setInterval(() => {
  countdown--;
  if (countdown <= 0) {
    clearInterval(timer);
    unlockBtn.disabled = false;
    countdownNote.style.display = "none";
    unlockBtn.textContent = "Verify Passphrase";
  } else {
    countdownSec.textContent = countdown;
  }
}, 1000);

// ── Start session ──────────────────────────────────────────

$("startSessionBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "START_SESSION" }, r => {
    if (r?.success) {
      window.close();
    } else {
      $("errMsg").textContent = "Could not start session — daily limit may be reached.";
    }
  });
});

// ── Passphrase unlock ──────────────────────────────────────

$("unlockBtn").addEventListener("click", () => {
  if (unlockBtn.disabled) return;
  const pass = $("passphraseInput").value.trim();
  if (!pass) {
    $("errMsg").textContent = "Enter the passphrase.";
    return;
  }
  chrome.runtime.sendMessage({ type: "VERIFY_PASSPHRASE", passphrase: pass }, r => {
    if (r?.valid) {
      $("errMsg").textContent = "";
      $("deterrenceMsg").style.display = "none";
      // Passphrase verified — close and let user proceed to extensions page
      // (they'll need to navigate back there manually since we closed it)
      $("errMsg").style.color = "#4ade80";
      $("errMsg").textContent = "Passphrase verified. You may now open chrome://extensions.";
      unlockBtn.textContent = "✓ Verified";
      unlockBtn.disabled = true;
    } else {
      $("errMsg").textContent = "Wrong passphrase. Attempt logged.";
      if (r?.deterrenceMessage) {
        const dm = $("deterrenceMsg");
        dm.textContent = r.deterrenceMessage;
        dm.style.display = "block";
      }
    }
  });
});
