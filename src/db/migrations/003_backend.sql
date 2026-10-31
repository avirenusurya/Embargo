-- Backend gap closure: statement revoke, held actions, savings + served versions in access logs, Postgres rate limiter,
-- anomaly tracking, re-copyable invite links, workspace deletion, digests, review reminders, prompt versions, graph sync lease.
ALTER TABLE statements ADD COLUMN revoked_at TIMESTAMPTZ;
ALTER TABLE statements ADD COLUMN revoked_by UUID;

ALTER TABLE access_logs ADD COLUMN block_versions JSONB;
ALTER TABLE access_logs ADD COLUMN tokens_original INT NOT NULL DEFAULT 0;
ALTER TABLE access_logs ADD COLUMN tokens_saved INT NOT NULL DEFAULT 0;
CREATE INDEX access_logs_conn ON access_logs(connection_id, created_at DESC);

ALTER TABLE block_versions ADD COLUMN source_type TEXT;
ALTER TABLE block_versions ADD COLUMN prompt_versions JSONB;

ALTER TABLE invites ADD COLUMN token_ct BYTEA;
ALTER TABLE invites ADD COLUMN token_nonce BYTEA;
ALTER TABLE invites ADD COLUMN data_key_id UUID;
ALTER TABLE invites ADD COLUMN created_by UUID;
ALTER TABLE invites ADD COLUMN revoked_at TIMESTAMPTZ;

ALTER TABLE workspaces ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE review_tokens ADD COLUMN reminded_at TIMESTAMPTZ;
ALTER TABLE graph_sync_cursor ADD COLUMN locked_until TIMESTAMPTZ;

CREATE TABLE held_actions(
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, connection_id UUID, user_id UUID,
  action TEXT NOT NULL, target_hint TEXT, audience TEXT NOT NULL, summary TEXT NOT NULL, reasons TEXT[] NOT NULL DEFAULT '{}',
  restricted_count INT NOT NULL DEFAULT 0, payload_ct BYTEA, payload_nonce BYTEA, data_key_id UUID, access_log_id UUID,
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','approved','denied')), decided_by UUID, decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX held_actions_ws ON held_actions(workspace_id, status, created_at DESC);

CREATE TABLE rate_limits(key TEXT NOT NULL, window_start BIGINT NOT NULL, count INT NOT NULL DEFAULT 0, PRIMARY KEY(key, window_start));

CREATE TABLE connection_ips(
  connection_id UUID NOT NULL, ip_range TEXT NOT NULL, last_ip TEXT, first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(connection_id, ip_range)
);
CREATE TABLE anomaly_alerts(
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, connection_id UUID, kind TEXT NOT NULL, detail JSONB NOT NULL DEFAULT '{}',
  dedupe_key TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE digest_runs(
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, period_start TIMESTAMPTZ NOT NULL, period_end TIMESTAMPTZ NOT NULL,
  stats JSONB NOT NULL DEFAULT '{}', delivered BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX digest_runs_ws ON digest_runs(workspace_id, created_at DESC);
