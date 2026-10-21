SET LOCAL search_path TO app_private, public;
CREATE TABLE job_runs (
  id TEXT PRIMARY KEY,
  job TEXT NOT NULL CHECK(job IN ('sync','notifications','cleanup','backup','restore')),
  slot TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK(status IN ('running','success','failed','deferred','interrupted')),
  detail JSONB NOT NULL DEFAULT '{}',
  UNIQUE(job,slot)
);
CREATE INDEX job_runs_recent ON job_runs(started_at DESC);
ALTER TABLE job_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY server_only ON job_runs TO aoki_app USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON job_runs TO aoki_app;
REVOKE ALL ON job_runs FROM PUBLIC,anon,authenticated;
ALTER TABLE receipt_notifications ADD COLUMN job_run_id TEXT UNIQUE REFERENCES job_runs(id);
-- Replace the original receipt-only constraint by its catalog-discovered name.
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='receipt_notifications'::regclass
    AND contype='c' AND pg_get_constraintdef(oid) LIKE '%inquiry_id%' LOOP
    EXECUTE format('ALTER TABLE receipt_notifications DROP CONSTRAINT %I',c.conname);
  END LOOP;
END $$;
ALTER TABLE receipt_notifications ADD CONSTRAINT notification_one_event CHECK
 ((inquiry_id IS NOT NULL)::int + (quote_id IS NOT NULL)::int + (job_run_id IS NOT NULL)::int = 1);
