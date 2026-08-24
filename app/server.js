'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createRemoteJWKSet, jwtVerify } = require('jose');
const { Pool } = require('pg');
const webpush = require('web-push');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATABASE_URL = process.env.DATABASE_URL;
const TIMER_MS = parseInt(process.env.BOTTLE_TIMER_MS || String(60 * 60 * 1000), 10);
const POLL_MS = parseInt(process.env.EXPIRY_POLL_MS || '15000', 10);
const DISPLAY_TZ = process.env.DISPLAY_TZ || 'America/New_York';
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT || '10', 10);
const HUCKLEBERRY_URL = process.env.HUCKLEBERRY_URL || 'http://huckleberry:8080';
const HUCKLEBERRY_MATCH_TOLERANCE_MS = 5000;

// DEV ONLY: lets the app be exercised locally without live Google OAuth
// credentials. Set DEV_MODE=true and send `X-Dev-User: <any-string-id>` to
// act as that user; first use auto-provisions the users row. MUST NOT be
// set true in any real deployment -- it bypasses authentication entirely.
const DEV_MODE = process.env.DEV_MODE === 'true';

// --- Google OAuth (OIDC) -----------------------------------------------
// Standard authorization_code + PKCE flow, RS256-signed ID tokens
// verifiable via Google's JWKS. Unlike a platform-scoped auth provider,
// Google's JWKS is shared across every Google OAuth client that exists --
// so `aud` MUST be checked against our own client_id, or any valid Google
// ID token minted for a completely different app would verify as ours.
const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// Must be the public HTTPS origin -- has to exactly match an Authorized
// redirect URI registered on the Google Cloud OAuth client, and Google
// checks this byte-for-byte (no wildcard/prefix matching).
const APP_ORIGIN = process.env.APP_ORIGIN || 'https://bottlecaps.dailey.cloud';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY;

if (!DATABASE_URL) {
  console.error('[bottlecaps] DATABASE_URL is required');
  process.exit(1);
}
if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('[bottlecaps] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are required for push notifications');
  process.exit(1);
}
if (!CREDENTIALS_ENCRYPTION_KEY || Buffer.from(CREDENTIALS_ENCRYPTION_KEY, 'hex').length !== 32) {
  console.error('[bottlecaps] CREDENTIALS_ENCRYPTION_KEY must be a 32-byte hex string (64 chars) -- generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}
if (!DEV_MODE && (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET)) {
  console.error('[bottlecaps] GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are required when DEV_MODE is not true');
  process.exit(1);
}
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
if (DEV_MODE) {
  console.warn('[bottlecaps] DEV_MODE=true -- authentication is BYPASSED. Never set this in a real deployment.');
}

const pool = new Pool({ connectionString: DATABASE_URL });

// --- Credential encryption (AES-256-GCM) --------------------------------
// Dailey encrypts env vars at rest, which covers CREDENTIALS_ENCRYPTION_KEY
// itself -- it does not cover arbitrary table data, so Huckleberry
// passwords get their own encryption layer here before ever touching the
// database.
const ENC_KEY = Buffer.from(CREDENTIALS_ENCRYPTION_KEY, 'hex');

function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptSecret(payload) {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// --- OAuth PKCE helpers (for the Google login flow) ---------------------

function generatePkceVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function pkceChallengeFromVerifier(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// --- Formatting helpers (unchanged from the single-tenant version) ------

function statusFromLatest(row) {
  if (!row) {
    return { loggedAt: null, expiresAt: null, remainingMs: 0, expired: true };
  }
  const loggedAt = row.logged_at;
  const expiresAt = new Date(loggedAt.getTime() + TIMER_MS);
  const remainingMs = Math.max(0, expiresAt.getTime() - Date.now());
  return {
    loggedAt: loggedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    remainingMs,
    expired: remainingMs <= 0,
  };
}

function fmtCountdown(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

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
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: DISPLAY_TZ });
}

function widgetText(row) {
  if (!row) return "No bottle logged yet.\nOpen bottlecaps to start.";
  const loggedAt = row.logged_at;
  const expiresAt = new Date(loggedAt.getTime() + TIMER_MS);
  const remainingMs = expiresAt.getTime() - Date.now();
  const agoLine = `started at ${fmtClock(loggedAt)}, ${fmtCompact(Date.now() - loggedAt.getTime())} ago`;
  if (remainingMs <= 0) return `🍾 Timer's up\n${agoLine}`;
  return `${fmtCountdown(remainingMs)} left\n${agoLine}`;
}

function parseOunces(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 20) return null;
  const cents = Math.round(n * 100);
  if (Math.abs(cents - n * 100) > 1e-6) return null;
  return cents / 100;
}

function rowToHistoryEntry(row) {
  return {
    id: row.id,
    loggedAt: row.logged_at.toISOString(),
    ounces: row.ounces === null ? null : Number(row.ounces),
    pendingOunces: row.pending_ounces === null ? null : Number(row.pending_ounces),
    huckleberryLogged: row.huckleberry_logged,
  };
}

// --- Auth --------------------------------------------------------------
//
// Google OAuth (OIDC). Users are identified by Google's `sub` claim --
// stable per Google account, unlike email (which can change). Stored in
// the `dailey_tenant` column (name is a holdover from an earlier Dailey
// Auth attempt that hit an unresolved platform bug -- see git history --
// not worth a migration just to rename an internal identifier column) as
// `google:<sub>`, the same `<provider>:<id>` shape DEV_MODE already uses
// for its `dev:<name>` users.
async function verifyGoogleIdToken(token) {
  const { payload } = await jwtVerify(token, GOOGLE_JWKS, {
    issuer: GOOGLE_ISSUER,
    audience: GOOGLE_CLIENT_ID,
  });
  if (!payload.sub) {
    throw new Error('token has no sub claim');
  }
  return {
    tenant: `google:${payload.sub}`,
    email: payload.email || null,
    name: payload.name || payload.given_name || null,
  };
}

// Google's id_token is short-lived (~1hr), but the session cookie holding
// it is long-lived -- without this, everyone gets silently signed out an
// hour after login regardless of the cookie's own maxAge. Mints a fresh
// id_token from the refresh_token captured at login (see /auth/callback).
async function refreshGoogleIdToken(refreshToken) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    throw new Error(`refresh_token grant failed: ${res.status} ${await res.text()}`);
  }
  const tokens = await res.json();
  if (!tokens.id_token) {
    throw new Error('refresh_token grant returned no id_token');
  }
  return tokens.id_token;
}

async function getOrCreateUser(tenant, email, name) {
  const existing = await pool.query('SELECT * FROM users WHERE dailey_tenant = $1', [tenant]);
  if (existing.rows.length > 0) return existing.rows[0];
  const widgetToken = crypto.randomBytes(24).toString('base64url');
  const inserted = await pool.query(
    'INSERT INTO users (dailey_tenant, email, name, widget_token) VALUES ($1, $2, $3, $4) RETURNING *',
    [tenant, email || null, name || null, widgetToken]
  );
  return inserted.rows[0];
}

async function requireAuth(req, res, next) {
  try {
    if (DEV_MODE) {
      const devUser = req.header('X-Dev-User');
      if (!devUser) return res.status(401).json({ error: 'missing_x_dev_user_header' });
      req.user = await getOrCreateUser(`dev:${devUser}`, null, devUser);
      return next();
    }
    const auth = req.header('Authorization') || '';
    const bearerToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    // Falls back to the session cookie set by /auth/callback -- the
    // frontend doesn't handle tokens directly at all in the real (non-dev)
    // flow, it just relies on the browser sending this cookie.
    const token = bearerToken || (req.cookies && req.cookies.bottlecaps_session);
    if (!token) return res.status(401).json({ error: 'missing_token' });
    let claims;
    try {
      claims = await verifyGoogleIdToken(token);
    } catch (err) {
      // The id_token itself expiring (~1hr) is the expected, common case --
      // silently mint a fresh one from the refresh_token cookie rather than
      // forcing a full re-login. Any other verification failure (bad
      // signature, wrong audience, etc.) still falls through to the 401.
      const encryptedRefresh = req.cookies && req.cookies.bottlecaps_refresh;
      if (err.code !== 'ERR_JWT_EXPIRED' || !encryptedRefresh) throw err;
      const newIdToken = await refreshGoogleIdToken(decryptSecret(encryptedRefresh));
      claims = await verifyGoogleIdToken(newIdToken);
      res.cookie('bottlecaps_session', newIdToken, {
        httpOnly: true, secure: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000,
      });
    }
    req.user = await getOrCreateUser(claims.tenant, claims.email, claims.name);
    next();
  } catch (err) {
    console.error('[auth] error', err);
    res.status(401).json({ error: 'unauthorized' });
  }
}

// --- Huckleberry -----------------------------------------------------------

async function getHuckleberryCreds(userId) {
  const res = await pool.query('SELECT * FROM huckleberry_credentials WHERE user_id = $1', [userId]);
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    email: row.email,
    password: decryptSecret(row.encrypted_password),
    child_uid: row.child_uid,
    bottle_type: row.bottle_type,
    timezone: row.timezone,
  };
}

async function logToHuckleberry(creds, loggedAt, ounces) {
  const res = await fetch(`${HUCKLEBERRY_URL}/log-bottle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...creds, start_time_iso: loggedAt.toISOString(), amount_oz: ounces }),
  });
  if (!res.ok) throw new Error(`huckleberry service ${res.status}: ${await res.text().catch(() => '')}`);
}

async function updateHuckleberryAmount(creds, loggedAt, ounces) {
  const res = await fetch(`${HUCKLEBERRY_URL}/update-bottle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...creds, start_time_iso: loggedAt.toISOString(), amount_oz: ounces }),
  });
  if (!res.ok) throw new Error(`huckleberry service ${res.status}: ${await res.text().catch(() => '')}`);
}

async function listHuckleberryBottles(creds, limit) {
  const params = new URLSearchParams({ ...creds, limit: String(limit) });
  const res = await fetch(`${HUCKLEBERRY_URL}/list-bottles?${params}`);
  if (!res.ok) throw new Error(`huckleberry service ${res.status}`);
  return (await res.json()).bottles || [];
}

/**
 * Pulls one user's last-HISTORY_LIMIT Huckleberry entries and reconciles
 * them against their `bottles` rows -- same two-directional logic as the
 * single-tenant version (self-heal huckleberry_logged on a timestamp match
 * within tolerance; insert a synthetic row, tagged source='huckleberry',
 * for anything with no local match), just scoped to one user_id throughout
 * and using that user's own decrypted credentials. Skipped entirely for
 * users with no Huckleberry credentials configured. Race-safety against
 * concurrent /api/history calls comes from the DB's unique index on
 * (user_id, huckleberry_start_iso), same role Mongo's partial unique index
 * played -- a duplicate insert attempt just fails and is swallowed.
 */
async function syncFromHuckleberry(userId) {
  const creds = await getHuckleberryCreds(userId);
  if (!creds) return;

  let remoteBottles;
  try {
    remoteBottles = await listHuckleberryBottles(creds, HISTORY_LIMIT);
  } catch (err) {
    console.error(`[huckleberry-sync] user ${userId}: list-bottles failed, serving local view only: ${err.message}`);
    return;
  }
  if (remoteBottles.length === 0) return;

  const oldestRemoteMs = Math.min(...remoteBottles.map((b) => new Date(b.start_iso).getTime()));
  const local = await pool.query(
    'SELECT id, logged_at, huckleberry_logged FROM bottles WHERE user_id = $1 AND logged_at >= $2',
    [userId, new Date(oldestRemoteMs - HUCKLEBERRY_MATCH_TOLERANCE_MS)]
  );
  const localBottles = local.rows;

  for (const remote of remoteBottles) {
    const remoteMs = new Date(remote.start_iso).getTime();
    const match = localBottles.find(
      (b) => Math.abs(b.logged_at.getTime() - remoteMs) <= HUCKLEBERRY_MATCH_TOLERANCE_MS
    );
    if (match) {
      if (!match.huckleberry_logged) {
        await pool.query('UPDATE bottles SET huckleberry_logged = true WHERE id = $1', [match.id]);
        match.huckleberry_logged = true;
      }
      continue;
    }
    try {
      const inserted = await pool.query(
        `INSERT INTO bottles (user_id, logged_at, ounces, notified, huckleberry_logged, source, huckleberry_start_iso)
         VALUES ($1, $2, $3, true, true, 'huckleberry', $4) RETURNING id, logged_at, huckleberry_logged`,
        [userId, new Date(remoteMs), remote.amount_oz, remote.start_iso]
      );
      localBottles.push(inserted.rows[0]);
      console.log(`[huckleberry-sync] user ${userId}: pulled in bottle at ${remote.start_iso}`);
    } catch (err) {
      if (err.code === '23505') continue; // unique_violation -- another concurrent call already inserted it
      throw err;
    }
  }
}

/**
 * Runs on an interval. For every user with an expired, not-yet-notified
 * latest bottle, sends that user's push subscriptions the expiry alert.
 * (Huckleberry logging stays manual, triggered per-row from the history
 * table.) The UPDATE ... WHERE notified = false RETURNING claim is the
 * multi-user equivalent of Mongo's per-document atomic updateOne claim --
 * safe under concurrent ticks/replicas without a separate lock.
 */
async function checkExpiryAndNotify() {
  try {
    const due = await pool.query(
      `UPDATE bottles b SET notified = true
       WHERE b.notified = false
         AND b.logged_at + ($1 || ' milliseconds')::interval <= now()
         AND b.id = (SELECT id FROM bottles WHERE user_id = b.user_id ORDER BY logged_at DESC LIMIT 1)
       RETURNING b.id, b.user_id`,
      [TIMER_MS]
    );
    for (const row of due.rows) {
      console.log(`[push] bottle ${row.id} (user ${row.user_id}) expired, notifying`);
      await broadcastPush(row.user_id, {
        title: '🍾 bottlecaps',
        body: 'Time’s up — dispose of any remaining volume.',
      });
    }
  } catch (err) {
    console.error('[expiry-check] error', err);
  }
}

async function broadcastPush(userId, payload) {
  const subs = await pool.query('SELECT * FROM push_subscriptions WHERE user_id = $1', [userId]);
  if (subs.rows.length === 0) return;
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.rows.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body);
      } catch (err) {
        const status = err && err.statusCode;
        if (status === 404 || status === 410) {
          await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
        } else {
          console.error(`[push] send failed (${status || 'unknown'}) for user ${userId}: ${err.message}`);
        }
      }
    })
  );
}

async function getSettings(userId) {
  const res = await pool.query('SELECT default_ounces FROM settings WHERE user_id = $1', [userId]);
  return { ounces: res.rows.length > 0 ? Number(res.rows[0].default_ounces) : 3 };
}

async function connectWithRetry(attempts = 20, delayMs = 1500) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1');
      console.log(`[postgres] connected (attempt ${i})`);
      return;
    } catch (err) {
      console.log(`[postgres] connect attempt ${i}/${attempts} failed: ${err.message}`);
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// The app runs its own schema DDL on boot rather than relying on a
// platform migration step. On Dailey OS, dailey_db_exec applies SQL as a
// short-lived exec user that gets dropped afterward -- any tables it
// creates end up owned by a role the app's own runtime DB user has no
// grants on (and dailey_db_exec forbids GRANT statements outright, so
// there's no way to hand that access back). Running CREATE TABLE as the
// app's own pool sidesteps the problem entirely: the app's DB role owns
// whatever it creates. Every statement is idempotent (IF NOT EXISTS), so
// this is safe to run on every boot.
const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dailey_tenant TEXT UNIQUE NOT NULL,
  email         TEXT,
  name          TEXT,
  widget_token  TEXT UNIQUE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bottles (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  logged_at              TIMESTAMPTZ NOT NULL,
  ounces                 NUMERIC(5,2),
  pending_ounces         NUMERIC(5,2),
  notified               BOOLEAN NOT NULL DEFAULT false,
  huckleberry_logged     BOOLEAN NOT NULL DEFAULT false,
  source                 TEXT,
  huckleberry_start_iso  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bottles_user_logged_at_idx ON bottles (user_id, logged_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS bottles_hb_start_iso_uidx
  ON bottles (user_id, huckleberry_start_iso) WHERE huckleberry_start_iso IS NOT NULL;
CREATE INDEX IF NOT EXISTS bottles_unnotified_idx ON bottles (user_id, logged_at DESC)
  WHERE notified = false;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, endpoint)
);

CREATE TABLE IF NOT EXISTS settings (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_ounces  NUMERIC(5,2) NOT NULL DEFAULT 3
);

CREATE TABLE IF NOT EXISTS huckleberry_credentials (
  user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email               TEXT NOT NULL,
  encrypted_password  TEXT NOT NULL,
  child_uid           TEXT,
  bottle_type         TEXT NOT NULL DEFAULT 'Formula',
  timezone            TEXT NOT NULL DEFAULT 'America/New_York',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function runMigrations() {
  await pool.query(SCHEMA_SQL);
  console.log('[postgres] schema migration applied (idempotent)');
}

async function main() {
  // depends_on only waits for the postgres *container* to start, not for
  // Postgres itself to be ready to accept connections -- retry instead of
  // relying on Docker's (much slower, noisier) whole-container restart loop.
  await connectWithRetry();
  await runMigrations();

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Public, unauthenticated -- lets the frontend decide at boot whether to
  // show the dev sign-in screen (X-Dev-User) or the real "Sign in with
  // Google" button, without hardcoding that choice into the static HTML.
  app.get('/api/config', (req, res) => {
    res.json({ devMode: DEV_MODE });
  });

  if (!DEV_MODE) {
    app.get('/auth/login', (req, res) => {
      const state = crypto.randomBytes(16).toString('base64url');
      const codeVerifier = generatePkceVerifier();
      const cookieOpts = { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 5 * 60 * 1000 };
      res.cookie('google_oauth_state', state, cookieOpts);
      res.cookie('google_oauth_verifier', codeVerifier, cookieOpts);
      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        response_type: 'code',
        redirect_uri: `${APP_ORIGIN}/auth/callback`,
        scope: 'openid profile email',
        state,
        code_challenge: pkceChallengeFromVerifier(codeVerifier),
        code_challenge_method: 'S256',
        // offline + consent so Google actually hands back a refresh_token
        // every time (by default it only does this on the very first
        // consent ever) -- needed to keep sessions alive past the
        // id_token's own ~1hr expiry without forcing a re-login.
        access_type: 'offline',
        prompt: 'consent',
      });
      res.redirect(`${GOOGLE_AUTHORIZE_URL}?${params.toString()}`);
    });

    app.get('/auth/callback', async (req, res) => {
      const expectedState = req.cookies.google_oauth_state;
      const codeVerifier = req.cookies.google_oauth_verifier;
      res.clearCookie('google_oauth_state');
      res.clearCookie('google_oauth_verifier');
      try {
        const { code, state } = req.query;
        if (!code || !state || !expectedState || state !== expectedState || !codeVerifier) {
          return res.status(400).send('Sign-in link expired or invalid -- please try signing in again.');
        }
        const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: String(code),
            redirect_uri: `${APP_ORIGIN}/auth/callback`,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            code_verifier: codeVerifier,
          }),
        });
        if (!tokenRes.ok) {
          console.error('[auth] token exchange failed', tokenRes.status, await tokenRes.text());
          return res.status(502).send('Sign-in failed -- could not exchange the login code. Please try again.');
        }
        const tokens = await tokenRes.json();
        // Only id_token is a verifiable JWT with sub/email/name claims --
        // access_token is opaque for Google, unlike some other providers.
        const sessionToken = tokens.id_token;
        if (!sessionToken) {
          console.error('[auth] token response had no id_token', Object.keys(tokens));
          return res.status(502).send('Sign-in failed -- no ID token returned. Please try again.');
        }
        // Round-trip it through our own verifier before trusting it as a
        // session -- if this throws, something's wrong with the token
        // Google handed back and we shouldn't set a cookie for it.
        await verifyGoogleIdToken(sessionToken);
        res.cookie('bottlecaps_session', sessionToken, {
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          maxAge: 30 * 24 * 60 * 60 * 1000,
        });
        if (tokens.refresh_token) {
          res.cookie('bottlecaps_refresh', encryptSecret(tokens.refresh_token), {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            maxAge: 180 * 24 * 60 * 60 * 1000,
          });
        } else {
          // Shouldn't happen given access_type=offline&prompt=consent above,
          // but isn't fatal either -- this session just won't auto-refresh
          // past its own id_token expiry, same as if this code didn't exist.
          console.warn('[auth] no refresh_token in token response -- session will not auto-refresh');
        }
        res.redirect('/');
      } catch (err) {
        console.error('[auth] callback error', err);
        res.status(500).send('Sign-in failed. Please try again.');
      }
    });

    app.get('/auth/logout', (req, res) => {
      res.clearCookie('bottlecaps_session');
      res.clearCookie('bottlecaps_refresh');
      res.redirect('/');
    });
  }

  // Widget text is deliberately NOT behind requireAuth -- the whole point
  // is a single no-JS "Get Contents of URL" Shortcuts action, which can't
  // carry a bearer token. Identified instead by each user's own opaque,
  // unguessable widget_token (see schema.sql).
  app.get('/api/widget-text', async (req, res) => {
    try {
      const token = req.query.token;
      if (!token) return res.status(400).type('text/plain').send('missing token');
      const user = await pool.query('SELECT id FROM users WHERE widget_token = $1', [token]);
      if (user.rows.length === 0) return res.status(404).type('text/plain').send('unknown token');
      const latest = await pool.query(
        'SELECT * FROM bottles WHERE user_id = $1 ORDER BY logged_at DESC LIMIT 1',
        [user.rows[0].id]
      );
      res.type('text/plain').send(widgetText(latest.rows[0] || null));
    } catch (err) {
      console.error('[widget-text] error', err);
      res.status(500).type('text/plain').send('bottlecaps: error');
    }
  });

  app.use('/api', requireAuth);

  app.get('/api/me', async (req, res) => {
    res.json({ id: req.user.id, email: req.user.email, name: req.user.name, widgetToken: req.user.widget_token });
  });

  // Issues a fresh widget_token, invalidating the old one -- for when it's
  // leaked (e.g. the Shortcut URL was shared/screenshotted). The old
  // Shortcuts widget stops working immediately; the user re-does the
  // one-action Shortcut setup with the new URL.
  app.post('/api/widget-token/regenerate', async (req, res) => {
    try {
      const widgetToken = crypto.randomBytes(24).toString('base64url');
      await pool.query('UPDATE users SET widget_token = $1 WHERE id = $2', [widgetToken, req.user.id]);
      res.json({ widgetToken });
    } catch (err) {
      console.error('[widget-token/regenerate] error', err);
      res.status(500).json({ error: 'failed' });
    }
  });

  app.get('/api/status', async (req, res) => {
    try {
      const latest = await pool.query(
        'SELECT * FROM bottles WHERE user_id = $1 ORDER BY logged_at DESC LIMIT 1',
        [req.user.id]
      );
      const total = await pool.query('SELECT count(*) FROM bottles WHERE user_id = $1', [req.user.id]);
      res.json({ ...statusFromLatest(latest.rows[0] || null), totalBottles: Number(total.rows[0].count), timerMs: TIMER_MS });
    } catch (err) {
      console.error('[status] error', err);
      res.status(500).json({ error: 'status_failed' });
    }
  });

  app.get('/api/history', async (req, res) => {
    try {
      await syncFromHuckleberry(req.user.id);
      const docs = await pool.query(
        'SELECT * FROM bottles WHERE user_id = $1 ORDER BY logged_at DESC LIMIT $2',
        [req.user.id, HISTORY_LIMIT + 1]
      );
      const page = docs.rows.slice(0, HISTORY_LIMIT);
      const rows = page.map((row, i) => {
        const prev = docs.rows[i + 1];
        return {
          ...rowToHistoryEntry(row),
          gapMs: prev ? row.logged_at.getTime() - prev.logged_at.getTime() : null,
        };
      });
      const gaps = rows.map((r) => r.gapMs).filter((g) => g !== null);
      const avgGapMs = gaps.length > 0 ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null;
      res.json({ rows, avgGapMs });
    } catch (err) {
      console.error('[history] error', err);
      res.status(500).json({ error: 'history_failed' });
    }
  });

  app.post('/api/bottle', async (req, res) => {
    let ounces;
    if (req.body?.ounces !== undefined) {
      ounces = parseOunces(req.body.ounces);
      if (ounces === null) return res.status(400).json({ error: 'invalid_ounces' });
    } else {
      ounces = (await getSettings(req.user.id)).ounces;
    }
    try {
      const loggedAt = new Date();
      await pool.query(
        'INSERT INTO bottles (user_id, logged_at, ounces, notified, huckleberry_logged) VALUES ($1, $2, $3, false, false)',
        [req.user.id, loggedAt, ounces]
      );
      await pool.query(
        `INSERT INTO settings (user_id, default_ounces) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET default_ounces = $2`,
        [req.user.id, ounces]
      );
      const total = await pool.query('SELECT count(*) FROM bottles WHERE user_id = $1', [req.user.id]);
      res.json({ ...statusFromLatest({ logged_at: loggedAt }), totalBottles: Number(total.rows[0].count), timerMs: TIMER_MS });
    } catch (err) {
      console.error('[bottle] error', err);
      res.status(500).json({ error: 'log_failed' });
    }
  });

  app.post('/api/bottle/cancel', async (req, res) => {
    try {
      const latest = await pool.query(
        'SELECT * FROM bottles WHERE user_id = $1 ORDER BY logged_at DESC LIMIT 1',
        [req.user.id]
      );
      const bottle = latest.rows[0];
      if (!bottle) return res.status(404).json({ error: 'no_active_bottle' });
      if (bottle.logged_at.getTime() + TIMER_MS <= Date.now()) return res.status(409).json({ error: 'not_active' });

      await pool.query('DELETE FROM bottles WHERE id = $1', [bottle.id]);
      const newLatest = await pool.query(
        'SELECT * FROM bottles WHERE user_id = $1 ORDER BY logged_at DESC LIMIT 1',
        [req.user.id]
      );
      const total = await pool.query('SELECT count(*) FROM bottles WHERE user_id = $1', [req.user.id]);
      res.json({ ...statusFromLatest(newLatest.rows[0] || null), totalBottles: Number(total.rows[0].count), timerMs: TIMER_MS });
    } catch (err) {
      console.error('[bottle/cancel] error', err);
      res.status(500).json({ error: 'cancel_failed' });
    }
  });

  app.delete('/api/bottle/:id', async (req, res) => {
    try {
      const found = await pool.query('SELECT * FROM bottles WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      const bottle = found.rows[0];
      if (!bottle) return res.status(404).json({ error: 'not_found' });
      if (bottle.huckleberry_logged) return res.status(409).json({ error: 'already_logged' });
      await pool.query('DELETE FROM bottles WHERE id = $1', [bottle.id]);
      res.json({ ok: true });
    } catch (err) {
      console.error('[bottle/delete] error', err);
      res.status(500).json({ error: 'delete_failed' });
    }
  });

  app.patch('/api/bottle/:id', async (req, res) => {
    const ounces = parseOunces(req.body?.ounces);
    if (ounces === null) return res.status(400).json({ error: 'invalid_ounces' });
    try {
      const found = await pool.query('SELECT * FROM bottles WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      const bottle = found.rows[0];
      if (!bottle) return res.status(404).json({ error: 'not_found' });

      if (bottle.huckleberry_logged) {
        const pendingOunces = ounces === Number(bottle.ounces) ? null : ounces;
        await pool.query('UPDATE bottles SET pending_ounces = $1 WHERE id = $2', [pendingOunces, bottle.id]);
        return res.json({ ok: true, pendingOunces });
      }

      await pool.query('UPDATE bottles SET ounces = $1 WHERE id = $2', [ounces, bottle.id]);
      await pool.query(
        `INSERT INTO settings (user_id, default_ounces) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET default_ounces = $2`,
        [req.user.id, ounces]
      );
      res.json({ ok: true, ounces });
    } catch (err) {
      console.error('[bottle/patch] error', err);
      res.status(500).json({ error: 'update_failed' });
    }
  });

  app.post('/api/bottle/:id/log-to-huckleberry', async (req, res) => {
    try {
      const found = await pool.query('SELECT * FROM bottles WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      const bottle = found.rows[0];
      if (!bottle) return res.status(404).json({ error: 'not_found' });
      if (bottle.huckleberry_logged) return res.status(409).json({ error: 'already_logged' });
      const creds = await getHuckleberryCreds(req.user.id);
      if (!creds) return res.status(400).json({ error: 'no_huckleberry_credentials' });

      const claim = await pool.query(
        'UPDATE bottles SET huckleberry_logged = true WHERE id = $1 AND huckleberry_logged = false',
        [bottle.id]
      );
      if (claim.rowCount === 0) return res.status(409).json({ error: 'already_logged' });

      try {
        await logToHuckleberry(creds, bottle.logged_at, Number(bottle.ounces ?? 3));
      } catch (err) {
        await pool.query('UPDATE bottles SET huckleberry_logged = false WHERE id = $1', [bottle.id]);
        console.error(`[huckleberry] manual log failed for bottle ${bottle.id}: ${err.message}`);
        return res.status(502).json({ error: 'huckleberry_failed' });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[bottle/log-to-huckleberry] error', err);
      res.status(500).json({ error: 'log_failed' });
    }
  });

  app.post('/api/bottle/:id/update-huckleberry', async (req, res) => {
    try {
      const found = await pool.query('SELECT * FROM bottles WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      const bottle = found.rows[0];
      if (!bottle) return res.status(404).json({ error: 'not_found' });
      if (!bottle.huckleberry_logged) return res.status(409).json({ error: 'not_logged_yet' });
      if (bottle.pending_ounces === null) return res.status(409).json({ error: 'no_pending_change' });
      const creds = await getHuckleberryCreds(req.user.id);
      if (!creds) return res.status(400).json({ error: 'no_huckleberry_credentials' });

      try {
        await updateHuckleberryAmount(creds, bottle.logged_at, Number(bottle.pending_ounces));
      } catch (err) {
        console.error(`[huckleberry] update failed for bottle ${bottle.id}: ${err.message}`);
        return res.status(502).json({ error: 'huckleberry_failed' });
      }
      await pool.query('UPDATE bottles SET ounces = pending_ounces, pending_ounces = NULL WHERE id = $1', [bottle.id]);
      res.json({ ok: true, ounces: Number(bottle.pending_ounces) });
    } catch (err) {
      console.error('[bottle/update-huckleberry] error', err);
      res.status(500).json({ error: 'update_failed' });
    }
  });

  app.get('/api/settings', async (req, res) => {
    try {
      res.json(await getSettings(req.user.id));
    } catch (err) {
      console.error('[settings] error', err);
      res.status(500).json({ error: 'settings_failed' });
    }
  });

  // --- Per-user Huckleberry credentials -----------------------------------
  // GET never returns the password (or its ciphertext) -- only whether
  // credentials are configured and the non-secret fields, matching how a
  // credentials form should behave (write-only password field).
  app.get('/api/huckleberry-credentials', async (req, res) => {
    try {
      const found = await pool.query('SELECT * FROM huckleberry_credentials WHERE user_id = $1', [req.user.id]);
      if (found.rows.length === 0) return res.json({ configured: false });
      const row = found.rows[0];
      res.json({
        configured: true,
        email: row.email,
        childUid: row.child_uid,
        bottleType: row.bottle_type,
        timezone: row.timezone,
      });
    } catch (err) {
      console.error('[huckleberry-credentials/get] error', err);
      res.status(500).json({ error: 'failed' });
    }
  });

  app.put('/api/huckleberry-credentials', async (req, res) => {
    const { email, password, childUid, bottleType, timezone } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email_required' });
    try {
      const existing = await pool.query(
        'SELECT encrypted_password FROM huckleberry_credentials WHERE user_id = $1',
        [req.user.id]
      );
      // Password is required on first-time setup, but optional on update --
      // an empty/omitted password means "keep the one already on file"
      // (the browser never gets it back to resend, per the write-only form).
      let encryptedPassword;
      if (password) {
        encryptedPassword = encryptSecret(password);
      } else if (existing.rows.length > 0) {
        encryptedPassword = existing.rows[0].encrypted_password;
      } else {
        return res.status(400).json({ error: 'password_required' });
      }
      await pool.query(
        `INSERT INTO huckleberry_credentials (user_id, email, encrypted_password, child_uid, bottle_type, timezone, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (user_id) DO UPDATE SET
           email = $2, encrypted_password = $3, child_uid = $4, bottle_type = $5, timezone = $6, updated_at = now()`,
        [req.user.id, email, encryptedPassword, childUid || null, bottleType || 'Formula', timezone || 'America/New_York']
      );
      res.json({ ok: true });
    } catch (err) {
      console.error('[huckleberry-credentials/put] error', err);
      res.status(500).json({ error: 'failed' });
    }
  });

  app.delete('/api/huckleberry-credentials', async (req, res) => {
    try {
      await pool.query('DELETE FROM huckleberry_credentials WHERE user_id = $1', [req.user.id]);
      res.json({ ok: true });
    } catch (err) {
      console.error('[huckleberry-credentials/delete] error', err);
      res.status(500).json({ error: 'failed' });
    }
  });

  app.get('/api/vapid-public-key', (req, res) => res.json({ publicKey: VAPID_PUBLIC_KEY }));

  app.post('/api/subscribe', async (req, res) => {
    const sub = req.body;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ error: 'invalid_subscription' });
    }
    try {
      await pool.query(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id, endpoint) DO UPDATE SET p256dh = $3, auth = $4, updated_at = now()`,
        [req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth]
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
      await pool.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [req.user.id, endpoint]);
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
