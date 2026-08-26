-- bottlecaps multi-tenant schema (Postgres). Run once against a fresh database.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid() is core since PG13, this is a defensive no-op fallback

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The `tenant` claim from Dailey Auth's JWT -- see app/server.js's auth
  -- middleware. Not a foreign key to anything Dailey-side; just the stable
  -- identifier Dailey issues per logged-in account.
  dailey_tenant TEXT UNIQUE NOT NULL,
  email         TEXT,
  name          TEXT,
  -- Opaque, unguessable token embedded in this user's iOS Shortcuts widget
  -- URL (GET /api/widget-text?token=...) -- the one endpoint that can't go
  -- through normal session auth, since it has to stay a single no-JS action
  -- for the Shortcuts app. Long-lived by design; regenerate via
  -- POST /api/widget-token if it ever leaks.
  -- Generated in Node (crypto.randomBytes(24).toString('base64url')) at
  -- insert time, not as a column default -- Postgres's own encode() has no
  -- base64url mode, only 'base64' (which isn't URL-safe as-is).
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
  -- Single-letter code for how this bottle got logged: 'T' timer button
  -- (the page itself, also the default), 'H' pulled in by the
  -- bidirectional Huckleberry sync, 'A' automatic via brezza-monitor.
  source                 TEXT NOT NULL DEFAULT 'T' CHECK (source IN ('T', 'H', 'A')),
  -- Dedup key for the sync's inserts -- the exact ISO start-time string
  -- Huckleberry reported. Mirrors Mongo's unique partial index on this
  -- field; same purpose (races between concurrent /api/history calls can't
  -- double-insert the same remote entry).
  huckleberry_start_iso  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bottles_user_logged_at_idx ON bottles (user_id, logged_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS bottles_hb_start_iso_uidx
  ON bottles (user_id, huckleberry_start_iso) WHERE huckleberry_start_iso IS NOT NULL;
-- checkExpiryAndNotify scans for "each user's single latest bottle that's
-- expired and not yet notified" every poll tick; this makes that a cheap
-- index-only lookup per user rather than a sort over the whole table.
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
  user_id               UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_ounces        NUMERIC(5,2) NOT NULL DEFAULT 3,
  auto_log_huckleberry  BOOLEAN NOT NULL DEFAULT true
);

-- One Huckleberry account per bottlecaps user. `encrypted_password` is
-- AES-256-GCM ciphertext (base64: iv || authTag || ciphertext), encrypted/
-- decrypted in app/server.js with CREDENTIALS_ENCRYPTION_KEY -- Dailey's
-- at-rest env var encryption covers that key itself, not arbitrary table
-- data, so the app has to do this layer itself.
CREATE TABLE IF NOT EXISTS huckleberry_credentials (
  user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email               TEXT NOT NULL,
  encrypted_password  TEXT NOT NULL,
  child_uid           TEXT,             -- optional: only needed for multi-child accounts
  bottle_type         TEXT NOT NULL DEFAULT 'Formula',
  timezone            TEXT NOT NULL DEFAULT 'America/New_York',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
