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
  {
    version: 9,
    sql: `
CREATE TABLE module_narratives (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  module_path TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  source_count INTEGER NOT NULL CHECK(source_count > 0),
  budget_chars INTEGER NOT NULL CHECK(budget_chars >= 500),
  version INTEGER NOT NULL CHECK(version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(repository_id, module_path)
);
CREATE TABLE module_narrative_sources (
  narrative_id TEXT NOT NULL REFERENCES module_narratives(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY(narrative_id, memory_id)
);
CREATE INDEX module_narrative_sources_memory ON module_narrative_sources(memory_id);
CREATE VIRTUAL TABLE module_narrative_fts USING fts5(
  narrative_id UNINDEXED,
  repository_id UNINDEXED,
  module_path,
  title,
  content
);
`,
  },
  {
    version: 10,
    sql: `
CREATE TABLE repository_profiles (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL UNIQUE REFERENCES repositories(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  memory_source_count INTEGER NOT NULL CHECK(memory_source_count >= 0),
  module_source_count INTEGER NOT NULL CHECK(module_source_count >= 0),
  budget_chars INTEGER NOT NULL CHECK(budget_chars >= 1000),
  min_confidence REAL NOT NULL CHECK(min_confidence >= 0 AND min_confidence <= 1),
  version INTEGER NOT NULL CHECK(version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(memory_source_count + module_source_count > 0)
);
CREATE TABLE repository_profile_memory_sources (
  profile_id TEXT NOT NULL REFERENCES repository_profiles(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY(profile_id, memory_id)
);
CREATE TABLE repository_profile_module_sources (
  profile_id TEXT NOT NULL REFERENCES repository_profiles(id) ON DELETE CASCADE,
  narrative_id TEXT NOT NULL REFERENCES module_narratives(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY(profile_id, narrative_id)
);
CREATE TABLE repository_profile_versions (
  profile_id TEXT NOT NULL REFERENCES repository_profiles(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  memory_ids_json TEXT NOT NULL,
  narrative_ids_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(profile_id, version)
);
CREATE INDEX repository_profile_memory_source ON repository_profile_memory_sources(memory_id);
CREATE INDEX repository_profile_module_source ON repository_profile_module_sources(narrative_id);
`,
  },
  {
    version: 11,
    sql: `
CREATE TABLE skill_candidates (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  workflow_key TEXT NOT NULL,
  title TEXT NOT NULL,
  trigger_text TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  verification_json TEXT NOT NULL,
  risks_json TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  source_session_count INTEGER NOT NULL CHECK(source_session_count >= 3),
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
  review_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  UNIQUE(repository_id, workflow_key)
);
CREATE TABLE skill_candidate_sessions (
  candidate_id TEXT NOT NULL REFERENCES skill_candidates(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY(candidate_id, session_id)
);
CREATE TABLE skill_candidate_evidence (
  candidate_id TEXT NOT NULL REFERENCES skill_candidates(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  PRIMARY KEY(candidate_id, evidence_id)
);
CREATE TABLE skill_candidate_audit_log (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES skill_candidates(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK(action IN ('generated','sources_changed','approved','rejected','exported')),
  previous_status TEXT CHECK(previous_status IS NULL OR previous_status IN ('pending','approved','rejected')),
  next_status TEXT NOT NULL CHECK(next_status IN ('pending','approved','rejected')),
  reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX skill_candidates_repository_status ON skill_candidates(repository_id, status, updated_at DESC);
CREATE INDEX skill_candidate_sessions_session ON skill_candidate_sessions(session_id);
CREATE INDEX skill_candidate_evidence_evidence ON skill_candidate_evidence(evidence_id);
CREATE INDEX skill_candidate_audit_candidate ON skill_candidate_audit_log(candidate_id, created_at);
`,
  },
  {
    version: 12,
    sql: `
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  checkout_id TEXT NOT NULL REFERENCES repository_checkouts(id),
  agent TEXT NOT NULL,
  external_session_id TEXT NOT NULL,
  current_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  last_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  current_task_event_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','ended')),
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ended_at INTEGER,
  UNIQUE(repository_id, agent, external_session_id)
);
CREATE TABLE activity_events (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  sequence INTEGER,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX agent_sessions_repository_seen
  ON agent_sessions(repository_id, last_seen_at DESC);
CREATE INDEX activity_events_repository_session
  ON activity_events(repository_id, session_id, occurred_at, id);
CREATE INDEX activity_events_agent_session
  ON activity_events(agent_session_id, occurred_at, id);
`,
  },
] as const;
