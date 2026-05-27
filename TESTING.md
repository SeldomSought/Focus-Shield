# Focus Shield — Manual Test Checklist v3.1

## How to load / reload

1. Chrome → `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `focus-shield` folder
3. After any code change: click the **↺ refresh** icon on the extension card

Open the **service worker** inspector link on the extension card to see `[Focus Shield]` background logs.
Open DevTools on any platform tab (Console) to see content script logs.

---

## Expected behavior: Focus Shield ON, no active session

A dark full-page **Focus Shield block screen** should appear — not a redirect.
The block screen shows:
- Platform name
- "This feed is blocked while Focus Shield is active."
- Remaining daily budget
- **Start free-scrolling session** button
- **Go to [reference]** button (navigates only when clicked)
- "Creation and reference surfaces are still available."

### X / Twitter

| URL | Expected |
|-----|----------|
| `https://x.com/` | Block screen |
| `https://x.com/home` | Block screen |
| `https://x.com/explore` | Block screen |
| `https://x.com/notifications` | Block screen |
| `https://x.com/search?q=test` | Block screen |
| `https://twitter.com/home` | Block screen |
| `https://x.com/i/bookmarks` | ✅ Allowed — no block screen |
| `https://x.com/compose/post` | ✅ Allowed |
| `https://x.com/messages` | ✅ Allowed |
| `https://x.com/elonmusk/status/123456789` | ✅ Allowed |
| `https://x.com/elonmusk` (profile) | ✅ Allowed (neutral) |

### YouTube

| URL | Expected |
|-----|----------|
| `https://www.youtube.com/` | Block screen |
| `https://www.youtube.com/feed/subscriptions` | Block screen |
| `https://www.youtube.com/shorts/abc123` | Block screen |
| `https://www.youtube.com/results?search_query=cats` | Block screen |
| `https://www.youtube.com/watch?v=dQw4w9WgXcQ` | ✅ Allowed |
| `https://www.youtube.com/feed/history` | ✅ Allowed |
| `https://www.youtube.com/playlist?list=WL` | ✅ Allowed |
| `https://studio.youtube.com` | ✅ Allowed (no content script, open) |

### Instagram

| URL | Expected |
|-----|----------|
| `https://www.instagram.com/` | Block screen |
| `https://www.instagram.com/explore` | Block screen |
| `https://www.instagram.com/reels` | Block screen |
| `https://www.instagram.com/reels/abc123` | Block screen |
| `https://www.instagram.com/stories` | Block screen |
| `https://www.instagram.com/direct/inbox/` | ✅ Allowed |
| `https://www.instagram.com/p/abc123/` | ✅ Allowed |
| `https://www.instagram.com/someuser/` (profile) | ✅ Allowed (neutral) |

---

## Expected behavior: SPA navigation (critical)

Social sites navigate without page reloads. The block screen must appear on route changes.

1. Go to `https://x.com/i/bookmarks` (allowed) — no block screen
2. Click **Home** in the Twitter sidebar
3. Expected: block screen appears immediately

4. Go to `https://www.youtube.com/feed/history` (allowed)
5. Click the YouTube logo (goes to home feed)
6. Expected: block screen appears immediately

7. Go to `https://www.instagram.com/direct/inbox/` (allowed)
8. Click the home icon
9. Expected: block screen appears immediately

---

## Expected behavior: Compose / Upload Content (no session consumed)

The block screen shows three buttons. The middle button navigates to the platform's
creation surface **without** starting a session or decrementing remaining time.

### X

1. Go to `https://x.com/home` (shield on, no session) → block screen
2. Click **Compose Post**
3. Expected: navigates to `x.com/compose/post` — no session started, timer unchanged

### YouTube

1. Go to `https://www.youtube.com/` → block screen
2. Click **Upload Video**
3. Expected: navigates to `youtube.com/upload` — no session started, timer unchanged

### Instagram (creation intent bypass)

1. Go to `https://www.instagram.com/` → block screen
2. Click **Open Instagram to Post**
3. Expected:
   - `creationIntent` is written to sessionStorage with 60-second expiry
   - Navigates to `instagram.com/`
   - Page loads (no block screen — intent is valid)
   - Timer is NOT decremented, no session started
4. Refresh the page after 60 seconds
5. Expected: block screen reappears (intent expired)

---

## Expected behavior: Start free-scrolling session

1. Block screen is shown on `x.com/home`
2. Click **Start free-scrolling session**
3. Expected:
   - Block screen disappears
   - Page content (`x.com/home`) becomes visible
   - A small timer pill appears (top-right) showing remaining time
   - Timer counts down

4. Click **Stop** in the timer pill
5. Expected: block screen reappears

6. Open popup — click **Start Session** — same result from the popup

---

## Expected behavior: Session timer expiry

1. In popup, reset budget to 1 minute (or use Reset Today then manually set limit to 1m)
2. Start a session
3. Wait for timer to reach 0
4. Expected:
   - Session stops automatically
   - Any open blocked-feed tabs show the block screen again
   - Popup shows "Daily budget exhausted"
   - Block screen shows "Daily budget exhausted — resets at midnight"

---

## Expected behavior: Shield disabled

1. Open popup → toggle **Focus Shield enabled** OFF
2. Visit `x.com/home`, `youtube.com/`, `instagram.com/`
3. Expected: all pages load normally, no block screen

---

## Debug logs to verify

Open DevTools Console on any platform tab. You should see:

```
[Focus Shield] Content script loaded on x.com /home
[Focus Shield] Initial state: { focusEnabled: true, sessionActive: false, remainingSeconds: 1800 }
[Focus Shield] Enforce | URL: https://x.com/home | surface: blocked (home feed) | focusEnabled: true | sessionActive: false | remaining: 1800s
[Focus Shield] Block screen shown: x (home feed)
```

On a SPA navigation:
```
[Focus Shield] URL changed → https://x.com/home
[Focus Shield] Enforce | URL: https://x.com/home | surface: blocked ...
[Focus Shield] Block screen shown: x (home feed)
```

---

## Known limitations

- `studio.youtube.com` has no content script (not matched) — always accessible, which is correct.
- Profile pages on X and Instagram are classified as "neutral" (allowed) — they don't have infinite feeds in the same way.
- The overlay guard uses MutationObserver on `<html>` — if a site completely replaces `document.documentElement`, the guard may need to restart. This is an edge case.
