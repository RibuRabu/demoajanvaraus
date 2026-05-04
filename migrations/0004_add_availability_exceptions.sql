CREATE TABLE availability_exceptions (
	id TEXT PRIMARY KEY,
	date_local TEXT NOT NULL,
	type TEXT NOT NULL,
	start_time_local TEXT,
	end_time_local TEXT,
	created_at_utc TEXT NOT NULL
);

CREATE INDEX idx_availability_exceptions_date
ON availability_exceptions(date_local);
