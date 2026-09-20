-- AI Browser 014 schema: independently revocable client devices and pairing offers.
-- Requires 001_init.sql. Safe to apply more than once.

CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('extension', 'mobile')),
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS devices_active_token_idx
  ON devices (token_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS devices_user_idx ON devices (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pairing_offers (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pairing_offers_user_open_idx
  ON pairing_offers (user_id, expires_at DESC) WHERE consumed_at IS NULL;
