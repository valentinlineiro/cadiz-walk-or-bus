-- Apply with: turso db shell <db-name> < migrations/0001_proxy_cache.sql
CREATE TABLE IF NOT EXISTS proxy_cache (
  key        TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS proxy_slot (
  name    TEXT PRIMARY KEY,
  next_at INTEGER NOT NULL
);
