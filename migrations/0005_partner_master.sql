-- Private local evidence; no candidate or external fallback is implied by failure.
CREATE TABLE partner_master_versions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('staging','ready','failed')),
  created_at INTEGER NOT NULL,
  content_digest TEXT NOT NULL,
  source_json TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  summary_json TEXT NOT NULL
);
CREATE TABLE partner_master_rows (
  version_id TEXT NOT NULL REFERENCES partner_master_versions(id),
  partner_id TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY(version_id,partner_id)
);
CREATE TABLE partner_master_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  current_version_id TEXT REFERENCES partner_master_versions(id),
  revision INTEGER NOT NULL DEFAULT 0,
  last_import_status TEXT NOT NULL DEFAULT 'empty' CHECK(last_import_status IN ('empty','ready','failed')),
  last_error TEXT
);
INSERT INTO partner_master_state(id,current_version_id,revision) VALUES(1,NULL,0);
CREATE INDEX partner_master_rows_name ON partner_master_rows(version_id,normalized_name);
