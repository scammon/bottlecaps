# bottlecaps

One big button. Press it to log a bottle and start a 1-hour timer. Press it
again anytime to log another and restart the timer. When the timer runs
out, you get a push notification — and, if enabled, the bottle is logged to
[Huckleberry](https://huckleberrycare.com/) automatically with the amount
you last selected.

Backed by a persistent local MongoDB, containerized with Docker Compose,
reachable from an iPhone (including over cellular) via Tailscale HTTPS.

## Features

- Big button, live countdown, "started at \<time\>, \<duration\> ago"
- Real Web Push notifications on expiry — fire even if the app isn't open
  (once installed to the Home Screen on iOS; see below)
- Cancel button (with a confirm modal) to discard the active bottle if it
  was a mis-press
- "Log bottle to Huckleberry" checkbox (default on) + an ounces dropdown
  (1–9, default 3, remembered in the DB) — on expiry, logs a `Formula`
  bottle feeding to Huckleberry with the bottle's actual start time
- Last-10 history table + average time between bottles, further down the
  page (scroll to see it)
- A `GET /api/widget-text` endpoint that returns ready-to-display plain
  text, for a one-action iOS Shortcuts Home Screen widget

## Architecture

Three Docker Compose services:

| Service       | What                                                              |
|---------------|--------------------------------------------------------------------|
| `mongo`       | `mongo:7`, data in a named volume (`mongo_data`), not host-exposed |
| `app`         | Node/Express + the static frontend. Publishes `3000`               |
| `huckleberry` | Tiny Python/aiohttp sidecar wrapping [`huckleberry-api`](https://github.com/Woyken/py-huckleberry-api) (requires Python ≥3.14, hence its own image/container instead of living in the Node app) |

`app` talks to `huckleberry` over the internal compose network
(`http://huckleberry:8080`) — it's never exposed to the host.

Mongo collections: `bottles` (one doc per press: `loggedAt`, `notified`,
`huckleberryLogged`), `subscriptions` (Web Push subscriptions), `settings`
(single doc: `huckleberryEnabled`, `ounces`).

The expiry check (push + Huckleberry logging) runs server-side on a poll
loop (`EXPIRY_POLL_MS`, default 15s), not client-side — so it fires
regardless of whether any tab/app is open, and survives app restarts (each
side effect is claimed via an atomic Mongo update, with the Huckleberry
side rolling back and retrying on failure).

## Setup

Requires Docker + Compose. (This deployment uses
[Colima](https://github.com/abiosoft/colima) instead of Docker Desktop —
see below if you're setting up fresh on a Mac with no Docker Desktop
installed.)

1. **Secrets** — copy the two `.env.example` files and fill them in:
   ```bash
   cp app.env.example app.env
   cp huckleberry.env.example huckleberry.env
   ```
   - `app.env`: a VAPID key pair for Web Push. Generate one with
     `node -e "console.log(require('web-push').generateVAPIDKeys())"`
     (needs `web-push` installed locally, or just run it inside the built
     `app` image).
   - `huckleberry.env`: your Huckleberry account email/password. If your
     account has more than one child, start the stack once, then hit
     `docker compose exec app curl http://huckleberry:8080/whoami` to see
     each child's `cid` and set `HUCKLEBERRY_CHILD_UID` explicitly —
     otherwise it auto-resolves to `lastChild` (or the only child, if
     there's just one).

   Both files are gitignored — never commit them.

2. **Build and start everything:**
   ```bash
   docker compose up -d --build
   ```

3. **Expose it over HTTPS** (required for push notifications on iOS —
   Safari refuses the Notification/Push APIs outside a secure context,
   `localhost` excepted). This deployment uses Tailscale:
   ```bash
   tailscale cert your-machine.your-tailnet.ts.net
   tailscale serve --bg 3000
   ```
   (Requires "HTTPS Certificates" enabled for your tailnet at
   https://login.tailscale.com/admin/dns.) Any other reverse proxy with a
   trusted cert works too — the app itself is plain HTTP on `3000`.

4. **On iOS**: open the HTTPS URL in Safari → **Share → Add to Home
   Screen** → open it *from that icon*, not the Safari tab. Push only
   delivers to the installed instance, not a regular Safari tab. Tap the
   button once to grant notification permission and register the push
   subscription.

### If you don't have Docker Desktop

This was set up without it (uninstalled, no GUI/admin-password access to
reinstall it non-interactively). [Colima](https://github.com/abiosoft/colima)
is a scriptable, GUI-free alternative:
```bash
brew install colima docker docker-compose
mkdir -p ~/.config/containers && cat > ~/.config/containers/storage.conf <<'EOF'
[storage]
driver = "vfs"
EOF
# ^ only needed if the default overlay/fuse-overlayfs driver errors with
# a permission-denied on your setup; vfs is slower but always works.
colima start
brew services start colima   # survive reboots
```

## iOS Home Screen widget (Shortcuts)

`GET /api/widget-text` returns pre-formatted plain text (countdown *or*
"Timer's up", plus "started at ..., ... ago"), timezone-fixed server-side
(`DISPLAY_TZ`, default `America/New_York`) — so the whole Shortcut is one
action:

1. Shortcuts app → **+** → add **"Get Contents of URL"** → your HTTPS URL
   + `/api/widget-text`
2. Name it, save
3. Home Screen → long-press → **+** → **Shortcuts** widget → pick it

Optional: add a second action, **"Open App"** targeting the installed
bottlecaps icon (not "Open URLs" — that opens a plain Safari tab, a
different context than the installed PWA that push/service-worker state is
tied to). Background widget refreshes silently skip that action; a real
tap runs it.

iOS controls widget refresh timing (typically 15–30+ min, sometimes
longer) — this isn't configurable from the shortcut or the app.

## API

| Route | Method | What |
|---|---|---|
| `/api/status` | GET | Latest bottle + countdown/expired state |
| `/api/bottle` | POST | Log a new bottle, restart the timer |
| `/api/bottle/cancel` | POST | Discard the active (not-yet-expired) bottle |
| `/api/history` | GET | Last 10 bottles with gaps + average gap |
| `/api/settings` | GET/POST | `huckleberryEnabled`, `ounces` (1–9) |
| `/api/widget-text` | GET | Plain-text summary, for the iOS Shortcut |
| `/api/vapid-public-key` | GET | VAPID public key, for `pushManager.subscribe` |
| `/api/subscribe` / `/api/unsubscribe` | POST | Web Push subscription management |

## Notes

- `huckleberry-api` is an **unofficial, reverse-engineered** client for
  Huckleberry's Firebase backend — not affiliated with or endorsed by
  Huckleberry Labs Inc. Personal use, at your own risk of it breaking if
  Huckleberry changes their backend.
- Bottle-type is hardcoded to `Formula` (`HUCKLEBERRY_BOTTLE_TYPE` in
  `huckleberry.env`) — change it there if that's wrong for you.
