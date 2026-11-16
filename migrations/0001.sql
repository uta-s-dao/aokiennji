PRAGMA foreign_keys=ON;
CREATE TABLE knowledge (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
INSERT INTO knowledge VALUES(1,0);
CREATE TABLE cases (id TEXT PRIMARY KEY, owner TEXT NOT NULL, create_key TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL DEFAULT 'collecting', snapshot TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, UNIQUE(owner,create_key));
CREATE TABLE case_events(id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), mutation_id TEXT NOT NULL, revision INTEGER NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(case_id,mutation_id));
CREATE TABLE research_jobs(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES cases(id), input_revision INTEGER NOT NULL, knowledge_revision INTEGER NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL, deadline INTEGER NOT NULL, lease_token TEXT, lease_until INTEGER, snapshot TEXT NOT NULL, usage TEXT NOT NULL DEFAULT '{}', UNIQUE(case_id,input_revision,knowledge_revision,attempt));
CREATE TABLE research_outbox(job_id TEXT PRIMARY KEY REFERENCES research_jobs(id), queued_at INTEGER, retry_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE results(job_id TEXT PRIMARY KEY REFERENCES research_jobs(id), public_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE sources(id TEXT PRIMARY KEY, version INTEGER NOT NULL, label TEXT NOT NULL, public_allowed INTEGER NOT NULL, ai_allowed INTEGER NOT NULL, role TEXT NOT NULL, confirmation_stage TEXT NOT NULL, is_demo INTEGER NOT NULL);
CREATE TABLE capability_rules(id TEXT PRIMARY KEY, json TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id));
CREATE TABLE attachments(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES cases(id), mutation_id TEXT NOT NULL, object_key TEXT NOT NULL, name TEXT NOT NULL,mime TEXT NOT NULL,byte_size INTEGER NOT NULL, analysis TEXT NOT NULL, supersedes TEXT, expires_at INTEGER NOT NULL, UNIQUE(case_id,mutation_id));
CREATE TABLE evidence(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES research_jobs(id),item_id TEXT NOT NULL,source_id TEXT NOT NULL,rule_id TEXT NOT NULL,public_label TEXT NOT NULL,checked_at INTEGER NOT NULL);
CREATE TABLE audit_events(id TEXT PRIMARY KEY,case_id TEXT,code TEXT NOT NULL,created_at INTEGER NOT NULL,detail TEXT NOT NULL DEFAULT '{}');
CREATE TABLE rate_limits(key TEXT PRIMARY KEY,window INTEGER NOT NULL,count INTEGER NOT NULL);
-- A failed guard aborts the entire D1 batch, including side effects after a CAS miss.
CREATE TABLE write_guards(id TEXT PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1));
CREATE INDEX jobs_due ON research_jobs(status,deadline);
CREATE INDEX outbox_due ON research_outbox(queued_at,retry_at);
CREATE INDEX attachments_case ON attachments(case_id);
