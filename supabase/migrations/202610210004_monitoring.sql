SET LOCAL search_path TO app_private, public;
CREATE TABLE monitoring_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  json JSONB NOT NULL
);
CREATE TABLE monitor_heartbeat (
  id INTEGER PRIMARY KEY CHECK(id=1),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  json JSONB NOT NULL
);
CREATE TABLE monitor_events (
  id TEXT PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL,
  json JSONB NOT NULL
);
CREATE INDEX monitor_events_recent ON monitor_events(occurred_at DESC);
DO $$ DECLARE n text; BEGIN
  FOREACH n IN ARRAY ARRAY['monitoring_settings','monitor_heartbeat','monitor_events'] LOOP
    EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',n);
    EXECUTE format('CREATE POLICY server_only ON app_private.%I TO aoki_app USING (true) WITH CHECK (true)',n);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON app_private.%I TO aoki_app',n);
    EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC,anon,authenticated',n);
  END LOOP;
END $$;
