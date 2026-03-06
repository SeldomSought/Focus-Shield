# Focus Shield

Locks social media feeds but keeps bookmarks, posting, and saved content fully accessible. Enforces a 30 min/day consumption limit across Twitter/X, Reddit, YouTube, Instagram, and Facebook.

## Loading the Extension (Chrome)

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `extension/` folder from this repo
5. The Focus Shield icon will appear in your toolbar

> **Edge / Brave:** Use `edge://extensions` or `brave://extensions` — same process.

## Features

- **Session-based timer** — start a session to unlock feeds; timer counts down real elapsed time
- **Commitment lock** — hand your device to an accountability partner to set a passphrase; settings cannot be changed without it (or while in an active session)
- **Platform CSS suppression** — `fs-locked` class applied to every platform page; hides feeds, recommended content, and nav items at the CSS level before any JS runs
- **Escape interrupt** — opening `chrome://extensions` while locked and outside a session triggers a high-friction popup
- **Tamper detection** — service worker gap detection + webhook alerts
- **Coach messages** — optional opt-in deterrence copy shown on failed disable attempts (off by default)
- **Webhook support** — POST events to any URL (heartbeat, tamper, escape attempts, etc.)

## Extension Structure

```
extension/
├── manifest.json          # MV3 manifest
├── background.js          # Service worker: timer, alarms, message handling
├── shared.js              # Content script: timer pill, overlays, fs-locked class
├── popup.html / popup.js  # Extension popup UI
├── escape.html / .js / .css  # Escape interrupt window
├── platform-scripts/
│   ├── twitter.js
│   ├── reddit.js
│   ├── youtube.js
│   ├── instagram.js
│   └── facebook.js
├── platform-styles/       # CSS gated behind body.fs-locked
│   ├── twitter.css
│   ├── reddit.css
│   ├── youtube.css
│   ├── instagram.css
│   └── facebook.css
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## How Protection Works

When **not** in an active session:
- `body.fs-locked` and `html.fs-locked` are added by `shared.js`
- Platform CSS rules hide feeds, sidebars, and recommendation widgets instantly
- A MutationObserver re-adds the class if a site's JS removes it
- The lock overlay blocks navigation to feed pages

When a **session starts**:
- Both locked classes are removed; the page reloads to restore native experience
- The timer pill shows remaining time with pause/stop controls

## Webhook Events

| Event | When |
|---|---|
| `heartbeat` | Every 5 minutes |
| `tamper_detected` | Service worker gap > 2 minutes |
| `extensions_page_opened` | User navigates to browser extensions page while locked |
| `escape_interrupt_shown` | Escape window opened (outside active session) |
| `disable_attempted` | Toggle-off denied outside session |
| `unlock_attempt_failed` | Wrong passphrase in gate or escape window |
| `commitment_activated` | Commitment lock enabled |
