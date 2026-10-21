SET LOCAL search_path TO app_private, public;
CREATE TABLE ai_budget_policy (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL DEFAULT 0,
  limit_microyen BIGINT NOT NULL DEFAULT 3000000000 CHECK(limit_microyen>=0),
  paused BOOLEAN NOT NULL DEFAULT false
);
ALTER TABLE ai_reservations ADD COLUMN detail JSONB NOT NULL DEFAULT '{}';
ALTER TABLE ai_reservations ADD COLUMN hold_reason TEXT;
CREATE TABLE billing_account (
  id INTEGER PRIMARY KEY CHECK(id=1),
  json JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE billing_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE billing_history (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail JSONB NOT NULL
);
CREATE TABLE budget_notifications (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  period TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','review')),
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at TIMESTAMPTZ,
  retry_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ
);
CREATE INDEX budget_notifications_delivery ON budget_notifications(status,retry_at);
DO $$ DECLARE n text; BEGIN
  FOREACH n IN ARRAY ARRAY['ai_budget_policy','billing_account','billing_events','billing_history','budget_notifications'] LOOP
    EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',n);
    EXECUTE format('CREATE POLICY server_only ON app_private.%I TO aoki_app USING (true) WITH CHECK (true)',n);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON app_private.%I TO aoki_app',n);
    EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC,anon,authenticated',n);
  END LOOP;
END $$;
