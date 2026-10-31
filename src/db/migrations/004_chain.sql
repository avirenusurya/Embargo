-- Relayer coordination (Part 14.5): one leader at a time (lease with expiry, works on PGlite and Postgres),
-- pause/resume when the relayer wallet cannot pay gas, and a stable leaf order for Merkle batches.
CREATE TABLE IF NOT EXISTS chain_leases(
  name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, acquired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS relayer_state(
  id TEXT PRIMARY KEY, paused_at TIMESTAMPTZ, pause_reason TEXT, last_balance_wei TEXT, needed_wei TEXT,
  resumed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS relayer_events(
  id UUID PRIMARY KEY, kind TEXT NOT NULL, detail JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE records ADD COLUMN IF NOT EXISTS batch_index INT;
CREATE INDEX IF NOT EXISTS records_unbatched ON records(created_at) WHERE batch_id IS NULL AND state = 'signed';
CREATE INDEX IF NOT EXISTS records_batch ON records(batch_id, batch_index);
