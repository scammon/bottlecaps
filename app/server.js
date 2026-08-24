'use strict';

const path = require('path');
const express = require('express');
const { MongoClient } = require('mongodb');
const webpush = require('web-push');

const PORT = parseInt(process.env.PORT || '3000', 10);
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/bottlecaps';
const TIMER_MS = parseInt(process.env.BOTTLE_TIMER_MS || String(60 * 60 * 1000), 10);
const POLL_MS = parseInt(process.env.EXPIRY_POLL_MS || '15000', 10);
const DISPLAY_TZ = process.env.DISPLAY_TZ || 'America/New_York';
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT || '10', 10);
const HUCKLEBERRY_URL = process.env.HUCKLEBERRY_URL || 'http://huckleberry:8080';

const DEFAULT_SETTINGS = { huckleberryEnabled: true, ounces: 3 };

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('[bottlecaps] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are required for push notifications');
  process.exit(1);
}
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

let bottlesCollection;
let subscriptionsCollection;
let settingsCollection;

async function getSettings() {
  const doc = await settingsCollection.findOne({ _id: 'singleton' });
  return {
    huckleberryEnabled: doc?.huckleberryEnabled ?? DEFAULT_SETTINGS.huckleberryEnabled,
    ounces: doc?.ounces ?? DEFAULT_SETTINGS.ounces,
  };
}

async function connectWithRetry(url, attempts = 20, delayMs = 1500) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const client = new MongoClient(url);
      await client.connect();
      console.log(`[mongo] connected (attempt ${i})`);
      return client;
    } catch (err) {
      console.log(`[mongo] connect attempt ${i}/${attempts} failed: ${err.message}`);
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

function statusFromLatest(doc) {
  if (!doc) {
    return { loggedAt: null, expiresAt: null, remainingMs: 0, expired: true };
  }
  const loggedAt = doc.loggedAt;
  const expiresAt = new Date(loggedAt.getTime() + TIMER_MS);
  const remainingMs = Math.max(0, expiresAt.getTime() - Date.now());
  return {
    loggedAt: loggedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    remainingMs,
    expired: remainingMs <= 0,
  };
}

// H:MM:SS countdown, e.g. "3:42:07".
function fmtCountdown(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Compact "3h 12m" / "12m 5s" / "45s" -- mirrors the web page's own format.
function fmtCompact(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtClock(date) {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: DISPLAY_TZ,
  });
}

// Plain-text summary for the iOS Shortcuts widget -- deliberately does all
// formatting server-side (fixed timezone, same style as the web UI) so the
// Shortcut itself only needs a single "Get Contents of URL" action.
function widgetText(doc) {
  if (!doc) return "No bottle logged yet.\nOpen bottlecaps to start.";
  const loggedAt = doc.loggedAt;
  const expiresAt = new Date(loggedAt.getTime() + TIMER_MS);
  const remainingMs = expiresAt.getTime() - Date.now();
  const agoLine = `started at ${fmtClock(loggedAt)}, ${fmtCompact(Date.now() - loggedAt.getTime())} ago`;
  if (remainingMs <= 0) {
    return `🍾 Timer's up\n${agoLine}`;
  }
  return `${fmtCountdown(remainingMs)} left\n${agoLine}`;
}

/**
 * Sends a push notification to every stored subscription. Subscriptions
 * that the push service reports as gone (404/410 -- the browser/OS dropped
 * them) are removed so the collection doesn't accumulate dead entries.
 */
async function broadcastPush(payload) {
  const subs = await subscriptionsCollection.find().toArray();
  if (subs.length === 0) {
    console.log('[push] no subscriptions to notify');
    return;
  }
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          body
        );
      } catch (err) {
        const status = err && err.statusCode;
        if (status === 404 || status === 410) {
          console.log(`[push] subscription gone, removing: ${sub.endpoint.slice(-24)}`);
          await subscriptionsCollection.deleteOne({ endpoint: sub.endpoint });
        } else {
          console.error(`[push] send failed (${status || 'unknown'}) for ${sub.endpoint.slice(-24)}: ${err.message}`);
        }
      }
    })
  );
}

/**
 * POSTs to the huckleberry sidecar service (see ./huckleberry), which wraps
 * py-huckleberry-api -- that library requires Python >=3.14, so it runs as
 * its own container rather than inside this Node image.
 */
async function logToHuckleberry(loggedAt, ounces) {
  const res = await fetch(`${HUCKLEBERRY_URL}/log-bottle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_time_iso: loggedAt.toISOString(), amount_oz: ounces }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`huckleberry service ${res.status}: ${text}`);
  }
}

/**
 * Runs on an interval. Finds the single latest bottle and, independently:
 *  - sends a push notification once it's expired and hasn't been notified;
 *  - logs it to Huckleberry once it's expired, huckleberryEnabled is on,
 *    and it hasn't been logged.
 * Each side is claimed via an atomic updateOne (safe across restarts/
 * replicas) and the Huckleberry side rolls its flag back on failure so the
 * next tick retries it, without re-sending the push.
 */
async function checkExpiryAndNotify() {
  try {
    const latest = await bottlesCollection.find().sort({ loggedAt: -1 }).limit(1).next();
    if (!latest) return;
    const expiresAt = latest.loggedAt.getTime() + TIMER_MS;
    if (Date.now() < expiresAt) return;

    if (!latest.notified) {
      const claim = await bottlesCollection.updateOne(
        { _id: latest._id, notified: { $ne: true } },
        { $set: { notified: true } }
      );
      if (claim.modifiedCount > 0) {
        console.log(`[push] bottle ${latest._id} expired, notifying`);
        await broadcastPush({
          title: '🍾 bottlecaps',
          body: "Time's up. Tap to log another.",
        });
      }
    }

    if (!latest.huckleberryLogged) {
      const settings = await getSettings();
      if (settings.huckleberryEnabled) {
        const claim = await bottlesCollection.updateOne(
          { _id: latest._id, huckleberryLogged: { $ne: true } },
          { $set: { huckleberryLogged: true } }
        );
        if (claim.modifiedCount > 0) {
          try {
            await logToHuckleberry(latest.loggedAt, settings.ounces);
            console.log(`[huckleberry] bottle ${latest._id} logged (${settings.ounces} oz)`);
          } catch (err) {
            console.error(`[huckleberry] log failed for bottle ${latest._id}, will retry: ${err.message}`);
            await bottlesCollection.updateOne({ _id: latest._id }, { $set: { huckleberryLogged: false } });
          }
        }
      }
    }
  } catch (err) {
    console.error('[expiry-check] error', err);
  }
}

async function main() {
  const client = await connectWithRetry(MONGO_URL);
  const db = client.db();
  bottlesCollection = db.collection('bottles');
  subscriptionsCollection = db.collection('subscriptions');
  settingsCollection = db.collection('settings');
  await bottlesCollection.createIndex({ loggedAt: -1 });
  await subscriptionsCollection.createIndex({ endpoint: 1 }, { unique: true });

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/status', async (req, res) => {
    try {
      const [latest, totalBottles] = await Promise.all([
        bottlesCollection.find().sort({ loggedAt: -1 }).limit(1).next(),
        bottlesCollection.countDocuments(),
      ]);
      res.json({ ...statusFromLatest(latest), totalBottles, timerMs: TIMER_MS });
    } catch (err) {
      console.error('[status] error', err);
      res.status(500).json({ error: 'status_failed' });
    }
  });

  // Last HISTORY_LIMIT bottles, each with the gap since the bottle before
  // it. Fetches one extra (older) document beyond the page so the oldest
  // row shown still gets a real gap instead of null.
  app.get('/api/history', async (req, res) => {
    try {
      const docs = await bottlesCollection
        .find()
        .sort({ loggedAt: -1 })
        .limit(HISTORY_LIMIT + 1)
        .toArray();
      const page = docs.slice(0, HISTORY_LIMIT);
      const rows = page.map((doc, i) => {
        const prev = docs[i + 1];
        return {
          loggedAt: doc.loggedAt.toISOString(),
          gapMs: prev ? doc.loggedAt.getTime() - prev.loggedAt.getTime() : null,
        };
      });
      const gaps = rows.map((r) => r.gapMs).filter((g) => g !== null);
      const avgGapMs = gaps.length > 0
        ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)
        : null;
      res.json({ rows, avgGapMs });
    } catch (err) {
      console.error('[history] error', err);
      res.status(500).json({ error: 'history_failed' });
    }
  });

  // Plain text, meant for the iOS Shortcuts app widget: a single
  // "Get Contents of URL" action can use this response directly with no
  // JSON parsing steps of its own.
  app.get('/api/widget-text', async (req, res) => {
    try {
      const latest = await bottlesCollection.find().sort({ loggedAt: -1 }).limit(1).next();
      res.type('text/plain').send(widgetText(latest));
    } catch (err) {
      console.error('[widget-text] error', err);
      res.status(500).type('text/plain').send('bottlecaps: error');
    }
  });

  app.post('/api/bottle', async (req, res) => {
    try {
      const loggedAt = new Date();
      await bottlesCollection.insertOne({ loggedAt, notified: false, huckleberryLogged: false });
      const totalBottles = await bottlesCollection.countDocuments();
      res.json({ ...statusFromLatest({ loggedAt }), totalBottles, timerMs: TIMER_MS });
    } catch (err) {
      console.error('[bottle] error', err);
      res.status(500).json({ error: 'log_failed' });
    }
  });

  // Discards the *active* (not-yet-expired) bottle -- used by the Cancel
  // button. Refuses once the timer has already expired, since at that
  // point it's history (and may already be mid-flight to Huckleberry/push).
  app.post('/api/bottle/cancel', async (req, res) => {
    try {
      const latest = await bottlesCollection.find().sort({ loggedAt: -1 }).limit(1).next();
      if (!latest) return res.status(404).json({ error: 'no_active_bottle' });
      const expiresAt = latest.loggedAt.getTime() + TIMER_MS;
      if (Date.now() >= expiresAt) return res.status(409).json({ error: 'not_active' });

      await bottlesCollection.deleteOne({ _id: latest._id });
      const [newLatest, totalBottles] = await Promise.all([
        bottlesCollection.find().sort({ loggedAt: -1 }).limit(1).next(),
        bottlesCollection.countDocuments(),
      ]);
      res.json({ ...statusFromLatest(newLatest), totalBottles, timerMs: TIMER_MS });
    } catch (err) {
      console.error('[bottle/cancel] error', err);
      res.status(500).json({ error: 'cancel_failed' });
    }
  });

  app.get('/api/settings', async (req, res) => {
    try {
      res.json(await getSettings());
    } catch (err) {
      console.error('[settings] error', err);
      res.status(500).json({ error: 'settings_failed' });
    }
  });

  app.post('/api/settings', async (req, res) => {
    const update = {};
    if (typeof req.body?.huckleberryEnabled === 'boolean') {
      update.huckleberryEnabled = req.body.huckleberryEnabled;
    }
    if (req.body?.ounces !== undefined) {
      const ounces = Number(req.body.ounces);
      if (!Number.isInteger(ounces) || ounces < 1 || ounces > 9) {
        return res.status(400).json({ error: 'ounces_out_of_range' });
      }
      update.ounces = ounces;
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'no_valid_fields' });
    }
    try {
      await settingsCollection.updateOne({ _id: 'singleton' }, { $set: update }, { upsert: true });
      res.json(await getSettings());
    } catch (err) {
      console.error('[settings] error', err);
      res.status(500).json({ error: 'settings_failed' });
    }
  });

  app.get('/api/vapid-public-key', (req, res) => {
    res.json({ publicKey: VAPID_PUBLIC_KEY });
  });

  app.post('/api/subscribe', async (req, res) => {
    const sub = req.body;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ error: 'invalid_subscription' });
    }
    try {
      await subscriptionsCollection.updateOne(
        { endpoint: sub.endpoint },
        { $set: { endpoint: sub.endpoint, keys: sub.keys, updatedAt: new Date() } },
        { upsert: true }
      );
      res.json({ ok: true });
    } catch (err) {
      console.error('[subscribe] error', err);
      res.status(500).json({ error: 'subscribe_failed' });
    }
  });

  app.post('/api/unsubscribe', async (req, res) => {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'missing_endpoint' });
    try {
      await subscriptionsCollection.deleteOne({ endpoint });
      res.json({ ok: true });
    } catch (err) {
      console.error('[unsubscribe] error', err);
      res.status(500).json({ error: 'unsubscribe_failed' });
    }
  });

  app.listen(PORT, () => {
    console.log(`[bottlecaps] listening on :${PORT}`);
  });

  setInterval(checkExpiryAndNotify, POLL_MS);
  checkExpiryAndNotify();
}

main().catch((err) => {
  console.error('[bottlecaps] fatal startup error', err);
  process.exit(1);
});
