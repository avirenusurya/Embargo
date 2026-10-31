CREATE TABLE schedule_runs(name TEXT NOT NULL, period TEXT NOT NULL, ran_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(name, period));
ALTER TABLE rules ADD COLUMN unlock_record_id UUID;
