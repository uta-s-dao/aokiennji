-- Private evidence is retained with its research job and never serialized by the case API.
CREATE TABLE partner_reports (
  job_id TEXT PRIMARY KEY REFERENCES research_jobs(id) ON DELETE CASCADE,
  report_json TEXT NOT NULL
);
