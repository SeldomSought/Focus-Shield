# Focus Shield — Manual Test Checklist

## How to load the extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `focus-shield` folder
5. The Focus Shield icon should appear in the toolbar

To reload after code changes: click the refresh icon on the extension card, or press `Ctrl+R` (Windows) / `Cmd+R` (Mac) on that card.

## Test: Shield active, no session

Open the popup and confirm: Shield enabled toggle is ON, no session is active.

| URL | Expected result |
|-----|----------------|
| `https://x.com/home` | Redirects to `https://x.com/i/bookmarks` |
| `https://twitter.com/home` | Redirects to `https://x.com/i/bookmarks` |
| `https://x.com/` | Redirects to `https://x.com/i/bookmarks` |
| `https://x.com/explore` | Redirects to `https://x.com/i/bookmarks` |
| `https://x.com/notifications` | Redirects to `https://x.com/i/bookmarks` |
| `https://x.com/search?q=test` | Redirects to `https://x.com/i/bookmarks` |
| `https://x.com/i/bookmarks` | **Stays — always allowed** |
| `https://x.com/compose/post` | **Stays — always allowed** |
| `https://x.com/messages` | **Stays — always allowed** |
| `https://x.com/elonmusk/status/123456789` | **Stays — always allowed** |
| `https://www.youtube.com/` | Redirects to `https://www.youtube.com/feed/history` |
| `https://www.youtube.com/feed/subscriptions` | Redirects to history |
| `https://www.youtube.com/shorts/abc123` | Redirects to history |
| `https://www.youtube.com/results?search_query=cats` | Redirects to history |
| `https://www.youtube.com/watch?v=dQw4w9WgXcQ` | **Stays — always allowed** |
| `https://www.youtube.com/feed/history` | **Stays — always allowed** |
| `https://www.youtube.com/playlist?list=WL` | **Stays — always allowed** |
| `https://studio.youtube.com` | **Stays — always allowed** |

## Test: Session active

1. Open popup, click "Start Session"
2. Popup shows "Free scrolling session active"

| URL | Expected result |
|-----|----------------|
| `https://x.com/home` | **Allowed — session active** |
| `https://www.youtube.com/` | **Allowed — session active** |
| `https://www.youtube.com/shorts/abc` | **Allowed — session active** |

3. Timer counts down in the popup
4. When time runs out: feeds block again, session stops automatically

## Test: Shield disabled

1. Open popup, toggle Focus Shield OFF

| URL | Expected result |
|-----|----------------|
| `https://x.com/home` | **Allowed — shield off** |
| `https://www.youtube.com/` | **Allowed — shield off** |

## Test: SPA navigation (important)

Twitter/X and YouTube navigate within the page without full reloads.

1. With shield ON and no session, go to `https://x.com/i/bookmarks` (allowed)
2. Click the "Home" link in the Twitter sidebar
3. Expected: **immediately redirects back to bookmarks**

4. Go to `https://www.youtube.com/feed/history` (allowed)
5. Click the YouTube logo (goes to home feed)
6. Expected: **immediately redirects to history**

## Test: Reset button

1. Open popup, click "Reset today's budget (testing)"
2. Timer resets to 30:00
3. Any active session is stopped

## Known limitations

- Timer accuracy: the alarm-based countdown in the background may drift by up to 30s per tick.
  The content script calculates remaining time from `sessionStartedAt` so it's accurate to ~1s.
- Studio.youtube.com: the content script doesn't run on studio.youtube.com (no content_script match),
  but that's fine since the background will allow it.
- Profile pages on X (e.g., `x.com/elonmusk`) are treated as "neutral" (not blocked, not explicitly allowed).
  They will pass through without redirect. This is intentional.
