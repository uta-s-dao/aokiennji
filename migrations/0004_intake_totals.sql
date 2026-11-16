-- Preserve only an aggregate count after the 90-day reservation metadata retention period.
CREATE TABLE intake_totals(id INTEGER PRIMARY KEY CHECK(id=1), calls INTEGER NOT NULL CHECK(calls>=0));
INSERT INTO intake_totals SELECT 1,COUNT(*) FROM intake_calls;
