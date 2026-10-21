SET LOCAL search_path TO app_private, public;
CREATE TABLE receipt_notifications (
  id TEXT PRIMARY KEY,
  inquiry_id TEXT UNIQUE REFERENCES inquiries(id),
  quote_id TEXT UNIQUE REFERENCES quotes(id),
  CHECK ((inquiry_id IS NOT NULL)::int + (quote_id IS NOT NULL)::int = 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','review')),
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at TIMESTAMPTZ,
  retry_at TIMESTAMPTZ,
  lease_token TEXT,
  payload JSONB,
  email_id TEXT UNIQUE,
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'unknown',
  delivery_rank INTEGER NOT NULL DEFAULT 0,
  delivery_at TIMESTAMPTZ
);
CREATE INDEX receipt_notifications_queue ON receipt_notifications(status,retry_at);
CREATE TABLE receipt_notification_attempts (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES receipt_notifications(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  outcome TEXT NOT NULL DEFAULT 'sending',
  http_status INTEGER
);
-- Store only routing metadata, never raw webhook bodies/customer details.
CREATE TABLE receipt_notification_events (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX receipt_notification_events_email ON receipt_notification_events(email_id);
CREATE TABLE receipt_notification_transport (
  id INTEGER PRIMARY KEY CHECK(id=1),
  domain_id TEXT NOT NULL,
  domain_name TEXT,
  status TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $$ DECLARE n text; BEGIN
  FOREACH n IN ARRAY ARRAY['receipt_notifications','receipt_notification_attempts','receipt_notification_events','receipt_notification_transport'] LOOP
    EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',n);
    EXECUTE format('CREATE POLICY server_only ON app_private.%I TO aoki_app USING (true) WITH CHECK (true)',n);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON app_private.%I TO aoki_app',n);
    EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC,anon,authenticated',n);
  END LOOP;
END $$;
