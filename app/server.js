'use strict';

const path = require('path');
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const webpush = require('web-push');

const PORT = parseInt(process.env.PORT || '3000', 10);
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/bottlecaps';
const TIMER_MS = parseInt(process.env.BOTTLE_TIMER_MS || String(60 * 60 * 1000), 10);
const POLL_MS = parseInt(process.env.EXPIRY_POLL_MS || '15000', 10);
const DISPLAY_TZ = process.env.DISPLAY_TZ || 'America/New_York';
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT || '10', 10);
const HUCKLEBERRY_URL = process.env.HUCKLEBERRY_URL || 'http://huckleberry:8080';
// How close a bottlecaps loggedAt and a real Huckleberry entry's start time
// have to be to be considered "the same bottle" during reconciliation.
const HUCKLEBERRY_MATCH_TOLERANCE_MS = 5000;

const DEFAULT_SETTINGS = { ounces: 3 };

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
  return { ounces: doc?.ounces ?? DEFAULT_SETTINGS.ounces };
}

// Ounces is a free-typed decimal now (the log-bottle modal's text field),
// not a constrained 1-9 dropdown -- real bottles (including ones pulled in
// from Huckleberry, converted from ml) commonly aren't whole numbers.
// Still validated: positive, sane upper bound, at most 2 decimal places.
function parseOunces(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 20) return null;
  const cents = Math.round(n * 100);
  if (Math.abs(cents - n * 100) > 1e-6) return null; // more than 2 decimal places
  return cents / 100;
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

// Corrects the amount on a bottle *already* logged to Huckleberry -- the
// history table's "Update" action (edit-then-commit on an already-logged
// row, as opposed to "Log", which creates a brand new entry).
async function updateHuckleberryAmount(loggedAt, ounces) {
  const res = await fetch(`${HUCKLEBERRY_URL}/update-bottle`, {
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
 * Pulls Huckleberry's own last-HISTORY_LIMIT bottle-feed entries and
 * reconciles them against bottlecaps' `bottles` collection -- the two
 * directions of the "bidirectional sync":
 *  - a bottlecaps bottle that's now confirmed present in Huckleberry (matched
 *    by start time within HUCKLEBERRY_MATCH_TOLERANCE_MS) gets huckleberryLogged
 *    self-healed to true, in case it was logged by some other path;
 *  - a Huckleberry entry with no matching bottlecaps document (logged straight
 *    in the Huckleberry app) gets inserted as a synthetic bottlecaps bottle
 *    (tagged source: 'huckleberry'), so it counts toward the last-10 history
 *    and the average gap.
 * Only ever asks for/considers the last HISTORY_LIMIT Huckleberry entries --
 * NOT a wide date-range's worth -- so this can't backfill your entire feed
 * history into bottlecaps' own collection.
 * The insert is race-safe: `huckleberryStartIso` (the exact string
 * Huckleberry reported) is uniquely indexed, so two concurrent requests
 * both trying to insert the same missing entry collide on the duplicate key
 * and only one insert survives -- necessary because /api/history (which
 * calls this) has no other locking and can genuinely run concurrently
 * (multiple tabs/devices, the 30s poll).
 * Best-effort: any failure (huckleberry service down, etc.) is logged and
 * swallowed so /api/history still serves the local view.
 */
async function syncFromHuckleberry() {
  let remoteBottles;
  try {
    const res = await fetch(`${HUCKLEBERRY_URL}/list-bottles?limit=${HISTORY_LIMIT}`);
    if (!res.ok) throw new Error(`huckleberry service ${res.status}`);
    const data = await res.json();
    remoteBottles = data.bottles || [];
  } catch (err) {
    console.error(`[huckleberry-sync] list-bottles failed, serving local view only: ${err.message}`);
    return;
  }

  if (remoteBottles.length === 0) return;

  const oldestRemoteMs = Math.min(...remoteBottles.map((b) => new Date(b.start_iso).getTime()));
  const localBottles = await bottlesCollection
    .find({ loggedAt: { $gte: new Date(oldestRemoteMs - HUCKLEBERRY_MATCH_TOLERANCE_MS) } })
    .toArray();

  for (const remote of remoteBottles) {
    const remoteMs = new Date(remote.start_iso).getTime();
    const match = localBottles.find(
      (b) => Math.abs(b.loggedAt.getTime() - remoteMs) <= HUCKLEBERRY_MATCH_TOLERANCE_MS
    );
    if (match) {
      if (!match.huckleberryLogged) {
        await bottlesCollection.updateOne({ _id: match._id }, { $set: { huckleberryLogged: true } });
        match.huckleberryLogged = true; // keep the in-memory copy consistent for this pass
      }
      continue;
    }
    // No local record at all -- logged directly in the Huckleberry app.
    try {
      const inserted = await bottlesCollection.insertOne({
        loggedAt: new Date(remoteMs),
        ounces: remote.amount_oz,
        notified: true, // never went through our own expiry flow
        huckleberryLogged: true,
        source: 'huckleberry',
        huckleberryStartIso: remote.start_iso,
      });
      localBottles.push({ _id: inserted.insertedId, loggedAt: new Date(remoteMs), huckleberryLogged: true });
      console.log(`[huckleberry-sync] pulled in bottle from Huckleberry at ${remote.start_iso}`);
    } catch (err) {
      if (err.code === 11000) {
        // Another concurrent call already inserted this one -- fine, not a real error.
        continue;
      }
      throw err;
    }
  }
}

/**
 * Runs on an interval. Sends a push notification once the latest bottle is
 * expired and hasn't been notified yet. (Huckleberry logging is manual now,
 * triggered per-row from the history table -- see POST /api/bottle/:id/log-
 * to-huckleberry.) Claimed via an atomic updateOne so this is safe across
 * restarts/replicas.
 */
async function checkExpiryAndNotify() {
  try {
    const latest = await bottlesCollection.find().sort({ loggedAt: -1 }).limit(1).next();
    if (!latest || latest.notified) return;
    const expiresAt = latest.loggedAt.getTime() + TIMER_MS;
    if (Date.now() < expiresAt) return;

    const claim = await bottlesCollection.updateOne(
      { _id: latest._id, notified: { $ne: true } },
      { $set: { notified: true } }
    );
    if (claim.modifiedCount > 0) {
      console.log(`[push] bottle ${latest._id} expired, notifying`);
      await broadcastPush({
        title: '🍾 bottlecaps',
        body: 'Time’s up — dispose of any remaining volume.',
      });
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
  // Race-safe dedup for syncFromHuckleberry's synthetic inserts -- see its
  // comment. Partial so it only applies to Huckleberry-sourced documents;
  // bottlecaps-native bottles never have this field.
  await bottlesCollection.createIndex(
    { huckleberryStartIso: 1 },
    { unique: true, partialFilterExpression: { huckleberryStartIso: { $exists: true } } }
  );
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
  // it, its ounces, and whether it's confirmed logged to Huckleberry.
  // Pulls + reconciles Huckleberry's own history first (see
  // syncFromHuckleberry) so entries logged directly in the Huckleberry app
  // show up here too. Fetches one extra (older) document beyond the page
  // so the oldest row shown still gets a real gap instead of null.
  app.get('/api/history', async (req, res) => {
    try {
      await syncFromHuckleberry();
      const docs = await bottlesCollection
        .find()
        .sort({ loggedAt: -1 })
        .limit(HISTORY_LIMIT + 1)
        .toArray();
      const page = docs.slice(0, HISTORY_LIMIT);
      const rows = page.map((doc, i) => {
        const prev = docs[i + 1];
        return {
          id: doc._id.toString(),
          loggedAt: doc.loggedAt.toISOString(),
          ounces: doc.ounces ?? null,
          pendingOunces: doc.pendingOunces ?? null,
          huckleberryLogged: !!doc.huckleberryLogged,
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
    let ounces;
    if (req.body?.ounces !== undefined) {
      ounces = parseOunces(req.body.ounces);
      if (ounces === null) return res.status(400).json({ error: 'invalid_ounces' });
    } else {
      ounces = (await getSettings()).ounces; // fallback if the client omits it
    }
    try {
      const loggedAt = new Date();
      await bottlesCollection.insertOne({
        loggedAt,
        ounces,
        notified: false,
        huckleberryLogged: false,
      });
      // Remember this as the default the log-bottle modal pre-fills next time.
      await settingsCollection.updateOne({ _id: 'singleton' }, { $set: { ounces } }, { upsert: true });
      const totalBottles = await bottlesCollection.countDocuments();
      res.json({ ...statusFromLatest({ loggedAt }), totalBottles, timerMs: TIMER_MS });
    } catch (err) {
      console.error('[bottle] error', err);
      res.status(500).json({ error: 'log_failed' });
    }
  });

  // Deletes any bottle record outright -- the history table's swipe-further
  // "Delete" action. Same Huckleberry-logged guard as PATCH: once a bottle
  // is confirmed logged, bottlecaps' copy needs to stay a truthful record
  // rather than silently vanishing out from under the real Huckleberry entry.
  app.delete('/api/bottle/:id', async (req, res) => {
    let _id;
    try {
      _id = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: 'invalid_id' });
    }
    try {
      const bottle = await bottlesCollection.findOne({ _id });
      if (!bottle) return res.status(404).json({ error: 'not_found' });
      if (bottle.huckleberryLogged) return res.status(409).json({ error: 'already_logged' });

      await bottlesCollection.deleteOne({ _id });
      res.json({ ok: true });
    } catch (err) {
      console.error('[bottle/delete] error', err);
      res.status(500).json({ error: 'delete_failed' });
    }
  });

  // Edits a bottle's ounces. Two different things happen depending on
  // whether it's already been logged to Huckleberry:
  //  - not yet logged: `ounces` is updated directly (nothing external to
  //    stay in sync with yet), and remembered as the new default for the
  //    next bottle -- unchanged from before.
  //  - already logged: bottlecaps' own record of what Huckleberry actually
  //    has (`ounces`) is left alone, and the new value is staged in
  //    `pendingOunces` instead. It only takes effect -- pushed to the real
  //    Huckleberry entry -- when the "Update" button (POST .../update-
  //    huckleberry, below) is pressed. Staging it server-side (rather than
  //    just in the browser) means it survives a page reload or the 30s
  //    auto-refresh instead of silently evaporating.
  //  Selecting the value that's already current (for whichever of the two
  //  above is the current one) clears any pending edit rather than staging
  //  a no-op, so re-selecting the original value is how you back out of an
  //  accidental edit.
  app.patch('/api/bottle/:id', async (req, res) => {
    const ounces = parseOunces(req.body?.ounces);
    if (ounces === null) {
      return res.status(400).json({ error: 'invalid_ounces' });
    }
    let _id;
    try {
      _id = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: 'invalid_id' });
    }
    try {
      const bottle = await bottlesCollection.findOne({ _id });
      if (!bottle) return res.status(404).json({ error: 'not_found' });

      if (bottle.huckleberryLogged) {
        const pendingOunces = ounces === bottle.ounces ? null : ounces;
        await bottlesCollection.updateOne({ _id }, { $set: { pendingOunces } });
        return res.json({ ok: true, pendingOunces });
      }

      await bottlesCollection.updateOne({ _id }, { $set: { ounces } });
      await settingsCollection.updateOne({ _id: 'singleton' }, { $set: { ounces } }, { upsert: true });
      res.json({ ok: true, ounces });
    } catch (err) {
      console.error('[bottle/patch] error', err);
      res.status(500).json({ error: 'update_failed' });
    }
  });

  // Manually logs one bottle to Huckleberry -- the only way it happens now
  // (see checkExpiryAndNotify's comment; this used to be automatic-on-expiry
  // gated by a since-removed "Log to Huckleberry" checkbox).
  app.post('/api/bottle/:id/log-to-huckleberry', async (req, res) => {
    let _id;
    try {
      _id = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: 'invalid_id' });
    }
    try {
      const bottle = await bottlesCollection.findOne({ _id });
      if (!bottle) return res.status(404).json({ error: 'not_found' });
      if (bottle.huckleberryLogged) return res.status(409).json({ error: 'already_logged' });

      const claim = await bottlesCollection.updateOne(
        { _id, huckleberryLogged: { $ne: true } },
        { $set: { huckleberryLogged: true } }
      );
      if (claim.modifiedCount === 0) return res.status(409).json({ error: 'already_logged' });

      try {
        await logToHuckleberry(bottle.loggedAt, bottle.ounces ?? DEFAULT_SETTINGS.ounces);
      } catch (err) {
        await bottlesCollection.updateOne({ _id }, { $set: { huckleberryLogged: false } });
        console.error(`[huckleberry] manual log failed for bottle ${_id}: ${err.message}`);
        return res.status(502).json({ error: 'huckleberry_failed' });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[bottle/log-to-huckleberry] error', err);
      res.status(500).json({ error: 'log_failed' });
    }
  });

  // Pushes a staged ounces correction (see PATCH above) to a bottle that's
  // already logged to Huckleberry -- the history table's "Update" action.
  // On failure, pendingOunces is left in place (not rolled back) so the
  // row keeps showing "Update" and the next attempt retries the same edit,
  // matching how log-to-huckleberry's own failure handling works.
  app.post('/api/bottle/:id/update-huckleberry', async (req, res) => {
    let _id;
    try {
      _id = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: 'invalid_id' });
    }
    try {
      const bottle = await bottlesCollection.findOne({ _id });
      if (!bottle) return res.status(404).json({ error: 'not_found' });
      if (!bottle.huckleberryLogged) return res.status(409).json({ error: 'not_logged_yet' });
      if (bottle.pendingOunces === null || bottle.pendingOunces === undefined) {
        return res.status(409).json({ error: 'no_pending_change' });
      }

      try {
        await updateHuckleberryAmount(bottle.loggedAt, bottle.pendingOunces);
      } catch (err) {
        console.error(`[huckleberry] update failed for bottle ${_id}: ${err.message}`);
        return res.status(502).json({ error: 'huckleberry_failed' });
      }
      await bottlesCollection.updateOne(
        { _id },
        { $set: { ounces: bottle.pendingOunces }, $unset: { pendingOunces: '' } }
      );
      res.json({ ok: true, ounces: bottle.pendingOunces });
    } catch (err) {
      console.error('[bottle/update-huckleberry] error', err);
      res.status(500).json({ error: 'update_failed' });
    }
  });

  // Discards the *active* (not-yet-expired) bottle -- used by the Cancel
  // button. Refuses once the timer has already expired, since at that
  // point it's history (and may already be logged to Huckleberry).
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
    if (req.body?.ounces === undefined) {
      return res.status(400).json({ error: 'no_valid_fields' });
    }
    const ounces = parseOunces(req.body.ounces);
    if (ounces === null) {
      return res.status(400).json({ error: 'invalid_ounces' });
    }
    try {
      await settingsCollection.updateOne({ _id: 'singleton' }, { $set: { ounces } }, { upsert: true });
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
