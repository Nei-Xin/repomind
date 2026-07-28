export const migrations = [
  {
    version: 1,
    sql: `
CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE repository_checkouts (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  root_path TEXT NOT NULL UNIQUE,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  checkout_id TEXT NOT NULL REFERENCES repository_checkouts(id),
  client_name TEXT,
  client_session_id TEXT,
  task TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','committed','partial','failed','abandoned')),
  baseline_branch TEXT,
  baseline_head TEXT,
  final_branch TEXT,
  final_head TEXT,
  baseline_dirty INTEGER NOT NULL,
  final_dirty INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  file_path TEXT,
  file_hash TEXT,
  commit_hash TEXT,
  metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  status TEXT NOT NULL CHECK(status IN ('active','uncertain','superseded','invalid')),
  scope_type TEXT NOT NULL CHECK(scope_type IN ('repository','module','path')),
  scope_value TEXT,
  source TEXT NOT NULL CHECK(source IN ('extracted','manual','imported')),
  tags_json TEXT NOT NULL DEFAULT '[]',
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_validated_at INTEGER,
  UNIQUE(repository_id, fingerprint)
);
CREATE TABLE memory_evidence (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE RESTRICT,
  PRIMARY KEY(memory_id, evidence_id)
);
CREATE TABLE memory_files (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_hash TEXT,
  PRIMARY KEY(memory_id, file_path)
);
CREATE TABLE memory_audit_log (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  previous_json TEXT,
  next_json TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE commit_receipts (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, idempotency_key)
);
CREATE VIRTUAL TABLE memory_fts USING fts5(
  memory_id UNINDEXED,
  repository_id UNINDEXED,
  title,
  content,
  search_tokens
);
CREATE INDEX sessions_repository_started ON sessions(repository_id, started_at);
CREATE INDEX evidence_repository_session_kind ON evidence(repository_id, session_id, kind);
CREATE INDEX memories_repository_status_type ON memories(repository_id, status, type);
CREATE INDEX memory_files_path ON memory_files(file_path);
`,
  },
  {
    version: 2,
    sql: `
ALTER TABLE memories ADD COLUMN status_reason_json TEXT;
`,
  },
  {
    version: 3,
    sql: `
CREATE TABLE memory_relations (
  source_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK(relation_type IN ('supersedes')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(source_memory_id, target_memory_id, relation_type),
  CHECK(source_memory_id <> target_memory_id)
);
CREATE INDEX memory_relations_target ON memory_relations(target_memory_id, relation_type);
`,
  },
  {
    version: 4,
    sql: `
CREATE TABLE forget_log (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('memory','memory-and-evidence')),
  evidence_deleted INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX forget_log_repository ON forget_log(repository_id, created_at);
`,
  },
  {
    version: 5,
    sql: `
CREATE TABLE memory_relations_v5 (
  source_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK(relation_type IN ('supersedes','contradicts')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(source_memory_id, target_memory_id, relation_type),
  CHECK(source_memory_id <> target_memory_id)
);
INSERT INTO memory_relations_v5 SELECT source_memory_id, target_memory_id, relation_type, created_at FROM memory_relations;
DROP TABLE memory_relations;
ALTER TABLE memory_relations_v5 RENAME TO memory_relations;
CREATE INDEX memory_relations_target ON memory_relations(target_memory_id, relation_type);
`,
  },
  {
    version: 6,
    sql: `
ALTER TABLE memory_files ADD COLUMN file_size INTEGER;
ALTER TABLE memory_files ADD COLUMN file_mtime_ms INTEGER;
`,
  },
  {
    version: 7,
    sql: `
CREATE TABLE memory_embeddings (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK(dimensions > 0),
  content_hash TEXT NOT NULL,
  embedding BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX memory_embeddings_repository_model ON memory_embeddings(repository_id, model);
`,
  },
  {
    version: 8,
    sql: `
CREATE TABLE host_runs (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  task TEXT NOT NULL,
  runner TEXT NOT NULL,
  model TEXT,
  output_directory TEXT NOT NULL,
  report_path TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','committed','partial','failed','abandoned')),
  agent_exit_code INTEGER,
  agent_signal TEXT,
  retrieved_memories INTEGER NOT NULL DEFAULT 0,
  duration_ms REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  repo_mind_calls INTEGER,
  error TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX host_runs_repository_started ON host_runs(repository_id, started_at DESC);
CREATE INDEX host_runs_repository_status ON host_runs(repository_id, status, started_at DESC);
`,
  },
] as const;
