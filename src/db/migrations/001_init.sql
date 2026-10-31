-- Embargo schema (Part 7). Ciphertext columns end in _ct; every encrypted value has a nonce and data_key_id.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users(
  id UUID PRIMARY KEY, display_name TEXT NOT NULL, email TEXT UNIQUE, wallet_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE passkey_credentials(
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT UNIQUE NOT NULL, public_key BYTEA NOT NULL, counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT[], created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE webauthn_challenges(
  id UUID PRIMARY KEY, challenge TEXT NOT NULL, user_id UUID, kind TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE magic_links(token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ);
CREATE TABLE sessions(
  token_hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspaces(
  id UUID PRIMARY KEY, name TEXT NOT NULL, owner_id UUID NOT NULL REFERENCES users(id), plan TEXT NOT NULL DEFAULT 'free',
  settings JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE memberships(
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','context_admin','editor','viewer')), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, workspace_id)
);
CREATE TABLE invites(
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, email TEXT, role TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL, expires_at TIMESTAMPTZ NOT NULL, accepted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE data_keys(
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, wrapped_key BYTEA,
  kek_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','destroyed')), purpose TEXT NOT NULL DEFAULT 'block',
  destroyed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE persons(
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id UUID REFERENCES users(id),
  display_name TEXT NOT NULL, contact_channel TEXT, contact_address_ct BYTEA, contact_nonce BYTEA, data_key_id UUID REFERENCES data_keys(id),
  is_external BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE blocks(
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, owner_id UUID NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('doc','conversation','repo','url','note','agent')),
  title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived','revoked')),
  access_mode TEXT NOT NULL DEFAULT 'viewable' CHECK (access_mode IN ('viewable','agent_only','sealed_use')),
  storage_mode TEXT NOT NULL DEFAULT 'standard' CHECK (storage_mode IN ('standard','sealed_block')),
  pinned BOOLEAN NOT NULL DEFAULT false, current_version_id UUID, source_ref JSONB, agent_written BOOLEAN NOT NULL DEFAULT false,
  processing_state TEXT NOT NULL DEFAULT 'ready', processing_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sealed_block_no_sealed_use CHECK (NOT (storage_mode = 'sealed_block' AND access_mode = 'sealed_use'))
);
CREATE INDEX blocks_ws_active ON blocks(workspace_id) WHERE status = 'active';

CREATE TABLE block_versions(
  id UUID PRIMARY KEY, block_id UUID NOT NULL REFERENCES blocks(id) ON DELETE CASCADE, version_no INT NOT NULL,
  structured_ct BYTEA, structured_nonce BYTEA, original_object_key TEXT, original_ct BYTEA, original_nonce BYTEA,
  data_key_id UUID NOT NULL REFERENCES data_keys(id), content_hash TEXT NOT NULL,
  tokens_original INT NOT NULL DEFAULT 0, tokens_compressed INT NOT NULL DEFAULT 0, created_by UUID, change_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(block_id, version_no)
);
CREATE TABLE block_sections(
  id UUID PRIMARY KEY, block_version_id UUID NOT NULL REFERENCES block_versions(id) ON DELETE CASCADE, ordinal INT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'section' CHECK (kind IN ('summary','section','decisions','facts','open_questions')),
  heading TEXT, text_ct BYTEA NOT NULL, nonce BYTEA NOT NULL, data_key_id UUID NOT NULL REFERENCES data_keys(id), tokens INT NOT NULL DEFAULT 0,
  flags TEXT[] NOT NULL DEFAULT '{}'
);
CREATE TABLE statements(
  id UUID PRIMARY KEY, block_version_id UUID NOT NULL REFERENCES block_versions(id) ON DELETE CASCADE, ordinal INT NOT NULL,
  speaker_person_id UUID REFERENCES persons(id), speaker_label TEXT, text_ct BYTEA NOT NULL, nonce BYTEA NOT NULL,
  data_key_id UUID NOT NULL REFERENCES data_keys(id), started_at_ms INT, tokens INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'allowed' CHECK (status IN ('allowed','held','team_only','blocked')),
  flags TEXT[] NOT NULL DEFAULT '{}', flag_reasons_ct BYTEA, flag_reasons_nonce BYTEA, decided_by UUID, decided_at TIMESTAMPTZ
);
CREATE TABLE facts(
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, block_id UUID NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  block_version_id UUID NOT NULL REFERENCES block_versions(id) ON DELETE CASCADE, section_id UUID, statement_id UUID,
  entity TEXT NOT NULL, attribute TEXT NOT NULL, value_ct BYTEA NOT NULL, value_nonce BYTEA NOT NULL, value_hash TEXT NOT NULL,
  data_key_id UUID NOT NULL REFERENCES data_keys(id), confidence REAL NOT NULL DEFAULT 0.7, extracted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX facts_ea ON facts(workspace_id, entity, attribute);

CREATE TABLE tags(id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name TEXT NOT NULL, UNIQUE(workspace_id, name));
CREATE TABLE block_tags(block_id UUID NOT NULL REFERENCES blocks(id) ON DELETE CASCADE, tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(block_id, tag_id));
CREATE TABLE collections(id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE collection_blocks(collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE, block_id UUID NOT NULL REFERENCES blocks(id) ON DELETE CASCADE, PRIMARY KEY(collection_id, block_id));

CREATE TABLE records(
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, event TEXT NOT NULL, subject_hash TEXT NOT NULL, workspace_hash TEXT NOT NULL,
  recipient_hash TEXT, scope_code INT NOT NULL DEFAULT 0, effective_at TIMESTAMPTZ NOT NULL,
  signer_type TEXT NOT NULL CHECK (signer_type IN ('user','server')), signer_address TEXT NOT NULL, signature TEXT,
  user_sig_hash TEXT, subject_ref JSONB, offchain JSONB, offchain_uid TEXT, leaf_hash TEXT, batch_id UUID, onchain_uid TEXT, tx_hash TEXT,
  state TEXT NOT NULL DEFAULT 'signed' CHECK (state IN ('signed','anchored','onchain','failed')), last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX records_ws ON records(workspace_id, created_at DESC);
CREATE TABLE record_batches(
  id UUID PRIMARY KEY, merkle_root TEXT NOT NULL, leaf_count INT NOT NULL, tx_hash TEXT, onchain_uid TEXT, anchored_at TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'signed', last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rules(
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('block','statement','card')), target_id UUID NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'team' CHECK (visibility IN ('private','team','partner','public')),
  partner_workspace_id UUID, allowed_connection_ids UUID[], purposes TEXT[], expires_at TIMESTAMPTZ, embargo_until TIMESTAMPTZ,
  answer_policy TEXT NOT NULL DEFAULT 'facts_only' CHECK (answer_policy IN ('facts_only','yes_no','summary')),
  set_by UUID, record_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX rules_target ON rules(target_type, target_id, created_at DESC);

CREATE TABLE connections(
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id UUID NOT NULL REFERENCES users(id),
  tool_label TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, scopes TEXT[] NOT NULL, last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cards(
  id UUID PRIMARY KEY, source_workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('user','workspace','link')),
  recipient_user_id UUID, recipient_workspace_id UUID, link_token_hash TEXT, block_ids UUID[], collection_id UUID,
  scope JSONB NOT NULL DEFAULT '{}', expires_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, expiry_recorded BOOLEAN NOT NULL DEFAULT false,
  share_record_id UUID, created_by UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE access_logs(
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, connection_id UUID, user_id UUID,
  channel TEXT NOT NULL CHECK (channel IN ('mcp','web','sealed','action')), tool TEXT, request_hash TEXT,
  block_ids UUID[] NOT NULL DEFAULT '{}', section_ids UUID[] NOT NULL DEFAULT '{}', statement_ids UUID[] NOT NULL DEFAULT '{}',
  withheld_count INT NOT NULL DEFAULT 0, decision JSONB, tokens_served INT NOT NULL DEFAULT 0, latency_ms INT NOT NULL DEFAULT 0,
  task_cluster_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX access_logs_ws ON access_logs(workspace_id, created_at DESC);
CREATE TABLE context_use_reports(
  id UUID PRIMARY KEY, access_log_id UUID NOT NULL, used_ids UUID[] NOT NULL DEFAULT '{}', ignored_ids UUID[] NOT NULL DEFAULT '{}',
  helpful BOOLEAN, source TEXT NOT NULL DEFAULT 'agent', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE review_tokens(
  token_hash TEXT PRIMARY KEY, person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  block_version_id UUID NOT NULL REFERENCES block_versions(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE access_requests(
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, connection_id UUID NOT NULL, target_type TEXT NOT NULL, target_id UUID NOT NULL,
  reason TEXT, status TEXT NOT NULL DEFAULT 'pending', decided_by UUID, decided_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE suggestions(
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('update','contradiction','stale','duplicate','gap','rule','expiry','onboarding','quality')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','rejected','auto_applied','superseded')),
  target_block_ids UUID[] NOT NULL DEFAULT '{}', target_versions JSONB NOT NULL DEFAULT '{}', summary TEXT NOT NULL,
  payload_ct BYTEA, payload_nonce BYTEA, data_key_id UUID REFERENCES data_keys(id), evidence JSONB NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 0.5, dedupe_key TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), decided_by UUID, decided_at TIMESTAMPTZ
);
CREATE INDEX suggestions_ws ON suggestions(workspace_id, status, created_at DESC);

CREATE TABLE embeddings(
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, owner_type TEXT NOT NULL CHECK (owner_type IN ('section','statement','block','query_cluster')),
  owner_id UUID NOT NULL, block_id UUID, vector vector(1536) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX embeddings_owner ON embeddings(owner_type, owner_id);
CREATE INDEX embeddings_ws ON embeddings(workspace_id);
CREATE INDEX embeddings_hnsw ON embeddings USING hnsw (vector vector_cosine_ops);
CREATE TABLE task_clusters(id UUID PRIMARY KEY, workspace_id UUID NOT NULL, centroid vector(1536) NOT NULL, label TEXT, size INT NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE query_log_embeddings(
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, access_log_id UUID NOT NULL, task_cluster_id UUID, vector vector(1536) NOT NULL,
  max_score REAL NOT NULL, query_ct BYTEA, query_nonce BYTEA, data_key_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE usage_priors(
  workspace_id UUID NOT NULL, block_id UUID NOT NULL, task_cluster_id UUID NOT NULL, alpha REAL NOT NULL DEFAULT 1, beta REAL NOT NULL DEFAULT 1,
  PRIMARY KEY(workspace_id, block_id, task_cluster_id)
);

CREATE TABLE integrations(
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('wispr','github','viasocket')), credentials_ct BYTEA, nonce BYTEA, data_key_id UUID REFERENCES data_keys(id),
  status TEXT NOT NULL DEFAULT 'active', meta JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, provider)
);

CREATE TABLE notifications(
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, user_id UUID NOT NULL, kind TEXT NOT NULL, hint TEXT NOT NULL, link TEXT,
  read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sealed_blocks(
  block_id UUID PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE, ciphertext TEXT NOT NULL, wrapped_dek TEXT NOT NULL, nonce TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE devices(
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id UUID NOT NULL, label TEXT NOT NULL,
  public_key TEXT NOT NULL, wrapped_wsk TEXT, approved_by UUID, approved_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE outbox(
  id BIGSERIAL PRIMARY KEY, topic TEXT NOT NULL, payload JSONB NOT NULL, available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INT NOT NULL DEFAULT 0, last_error TEXT, processed_at TIMESTAMPTZ, dead BOOLEAN NOT NULL DEFAULT false, locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending ON outbox(available_at) WHERE processed_at IS NULL;
CREATE TABLE graph_sync_cursor(id TEXT PRIMARY KEY, last_outbox_id BIGINT NOT NULL DEFAULT 0);

CREATE TABLE billing(
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, provider_customer_id TEXT, subscription_id TEXT,
  plan TEXT NOT NULL DEFAULT 'free', status TEXT NOT NULL DEFAULT 'inactive', current_period_end TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE webhook_events(id TEXT PRIMARY KEY, provider TEXT NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE usage_counters(workspace_id UUID NOT NULL, metric TEXT NOT NULL, period TEXT NOT NULL, value INT NOT NULL DEFAULT 0, PRIMARY KEY(workspace_id, metric, period));
