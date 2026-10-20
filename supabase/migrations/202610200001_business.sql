-- Apply once using the migration role; application requests never execute DDL.
CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anon, authenticated;
SET LOCAL search_path TO app_private, public;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aoki_app') THEN
    CREATE ROLE aoki_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT aoki_app TO CURRENT_USER;

    CREATE TABLE metadata (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE settings (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL CHECK (json::jsonb IS NOT NULL));
    CREATE TABLE products (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY, source_id TEXT, supplier_id TEXT, model_key TEXT, json TEXT NOT NULL CHECK (json::jsonb IS NOT NULL));
    CREATE UNIQUE INDEX idx_product_source_model ON products(source_id,model_key) WHERE source_id IS NOT NULL AND model_key IS NOT NULL AND model_key!='';
    CREATE TABLE sources (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY, json TEXT NOT NULL CHECK (json::jsonb IS NOT NULL));
    CREATE TABLE source_runs (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), json TEXT NOT NULL CHECK (json::jsonb IS NOT NULL));
    CREATE TABLE documents (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), content TEXT NOT NULL, json TEXT NOT NULL CHECK (json::jsonb IS NOT NULL));
    CREATE TABLE suppliers (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY, json TEXT NOT NULL CHECK (json::jsonb IS NOT NULL));
    CREATE TABLE supplier_knowledge (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), json TEXT NOT NULL CHECK (json::jsonb IS NOT NULL));
    CREATE TABLE conversations (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, json TEXT NOT NULL CHECK (json::jsonb IS NOT NULL));
    CREATE TABLE messages (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, json TEXT NOT NULL CHECK (json::jsonb IS NOT NULL));
    CREATE INDEX messages_conversation ON messages(conversation_id);
    CREATE TABLE inquiries (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY, json TEXT NOT NULL CHECK (json::jsonb IS NOT NULL));
    CREATE TABLE quotes (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, json TEXT NOT NULL CHECK (json::jsonb IS NOT NULL));
    CREATE TABLE orders (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY, quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id), idempotency_key TEXT NOT NULL, json TEXT NOT NULL CHECK (json::jsonb IS NOT NULL));
    CREATE TABLE audit_events (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY, json TEXT NOT NULL CHECK (json::jsonb IS NOT NULL));
    CREATE TABLE ai_calls (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL, provider TEXT NOT NULL, conversation_id TEXT, turn_id TEXT, scope TEXT NOT NULL, json TEXT NOT NULL CHECK (json::jsonb IS NOT NULL));
    CREATE INDEX ai_calls_created ON ai_calls(created_at);
    CREATE INDEX ai_calls_turn ON ai_calls(turn_id);
    CREATE TABLE sessions (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY, kind TEXT NOT NULL, expires_at BIGINT NOT NULL);
    CREATE TABLE rate_limits (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at BIGINT NOT NULL);
    CREATE TABLE import_previews (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), expires_at BIGINT NOT NULL, json TEXT NOT NULL CHECK (json::jsonb IS NOT NULL));
    CREATE TABLE research_notes (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL, json TEXT NOT NULL CHECK (json::jsonb IS NOT NULL));
    CREATE INDEX research_notes_conversation ON research_notes(conversation_id);
    CREATE TABLE procurement_cases (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY, context_key TEXT NOT NULL, model_key TEXT NOT NULL, json TEXT NOT NULL CHECK (json::jsonb IS NOT NULL));
    CREATE INDEX procurement_cases_context ON procurement_cases(context_key);
    CREATE INDEX procurement_cases_model ON procurement_cases(model_key);
    CREATE TABLE procurement_events (sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY, context_key TEXT NOT NULL, case_id TEXT, json TEXT NOT NULL CHECK (json::jsonb IS NOT NULL));
    CREATE INDEX procurement_events_context ON procurement_events(context_key);

CREATE TABLE site_content (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0), draft TEXT NOT NULL CHECK(draft::jsonb IS NOT NULL), published TEXT NOT NULL CHECK(published::jsonb IS NOT NULL), published_at TIMESTAMPTZ);
CREATE TABLE site_images (id TEXT PRIMARY KEY, bytes BYTEA NOT NULL CHECK(octet_length(bytes)<=5242880), created_at TIMESTAMPTZ NOT NULL);
CREATE TABLE request_keys (scope TEXT NOT NULL, key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 128), request_hash TEXT NOT NULL, response TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(scope,key));
CREATE TABLE ai_budgets (period TEXT PRIMARY KEY, limit_microyen BIGINT NOT NULL CHECK(limit_microyen>=0), reserved_microyen BIGINT NOT NULL DEFAULT 0 CHECK(reserved_microyen>=0), spent_microyen BIGINT NOT NULL DEFAULT 0 CHECK(spent_microyen>=0));
CREATE TABLE ai_reservations (id TEXT PRIMARY KEY, period TEXT NOT NULL REFERENCES ai_budgets(period), reserved_microyen BIGINT NOT NULL CHECK(reserved_microyen>=0), settled_microyen BIGINT CHECK(settled_microyen>=0), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX quote_conversation ON quotes ((json::jsonb->>'conversationId'));
CREATE INDEX session_expiry ON sessions(expires_at);
CREATE INDEX preview_expiry ON import_previews(expires_at);
CREATE INDEX request_created ON request_keys(created_at);
GRANT USAGE ON SCHEMA app_private TO aoki_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA app_private TO aoki_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA app_private TO aoki_app;
-- Defense in depth: no browser role can enter the schema or use a table.
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='app_private' LOOP
    EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',t.tablename);
    EXECUTE format('CREATE POLICY server_only ON app_private.%I TO aoki_app USING (true) WITH CHECK (true)',t.tablename);
    EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC,anon,authenticated',t.tablename);
  END LOOP;
END $$;
