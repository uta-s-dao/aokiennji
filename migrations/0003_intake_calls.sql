-- Reservations are retained as counters even after private result snapshots are purged.
CREATE TABLE intake_calls (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL, mutation_id TEXT NOT NULL,
 expected_revision INTEGER NOT NULL, fingerprint TEXT NOT NULL, provider TEXT NOT NULL,
 model TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT,
 input_tokens INTEGER, output_tokens INTEGER, error_code TEXT, created_at INTEGER NOT NULL,
 UNIQUE(case_id,mutation_id)
);
CREATE INDEX intake_case ON intake_calls(case_id);
CREATE TABLE intake_controls (id INTEGER PRIMARY KEY CHECK(id=1), blocked_reason TEXT);
INSERT INTO intake_controls VALUES(1,NULL);
