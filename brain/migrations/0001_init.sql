-- Pixie orchestrator: global registry (users, devices, pairing). Per-user data lives in the UserBrain DO.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,               -- usr_...
  name        TEXT NOT NULL,
  is_owner    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL                -- unix ms
);

-- At most one owner: the first registration claims the instance atomically via this index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_owner ON users(is_owner) WHERE is_owner = 1;

CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,               -- dev_...
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('mac', 'android', 'ide')),
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,           -- hex SHA-256 of the bearer token; the token itself is never stored
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

CREATE TABLE IF NOT EXISTS pair_codes (
  code        TEXT PRIMARY KEY,               -- 6 digits
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER                         -- NULL until claimed (single use)
);
CREATE INDEX IF NOT EXISTS idx_pair_codes_expires ON pair_codes(expires_at);

-- Failed pairing claims, for per-IP rate limiting (max 10 per 10 minutes).
CREATE TABLE IF NOT EXISTS pair_failures (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ip          TEXT NOT NULL,
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pair_failures_ip_ts ON pair_failures(ip, ts);
