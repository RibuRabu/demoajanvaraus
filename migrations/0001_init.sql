CREATE TABLE services (
	id INTEGER PRIMARY KEY,
	code TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	duration_minutes INTEGER NOT NULL,
	is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE weekly_hours (
	weekday INTEGER PRIMARY KEY,
	enabled INTEGER NOT NULL,
	start_time_local TEXT,
	end_time_local TEXT
);

CREATE TABLE bookings (
	id TEXT PRIMARY KEY,
	service_id INTEGER NOT NULL,
	customer_name TEXT NOT NULL,
	customer_email TEXT NOT NULL,
	customer_address TEXT NOT NULL,
	starts_at_utc TEXT NOT NULL,
	ends_at_utc TEXT NOT NULL,
	timezone TEXT NOT NULL,
	status TEXT NOT NULL,
	created_at_utc TEXT NOT NULL,
	FOREIGN KEY (service_id) REFERENCES services(id)
);

CREATE INDEX idx_bookings_starts_at_utc ON bookings(starts_at_utc);
CREATE INDEX idx_bookings_ends_at_utc ON bookings(ends_at_utc);
CREATE INDEX idx_bookings_status_starts_at_utc ON bookings(status, starts_at_utc);

INSERT INTO services (id, code, name, duration_minutes, is_active) VALUES
	(1, '60', '60 min', 60, 1),
	(2, '90', '90 min', 90, 1),
	(3, '120', '120 min', 120, 1);

INSERT INTO weekly_hours (weekday, enabled, start_time_local, end_time_local) VALUES
	(1, 1, '10:00', '18:00'),
	(2, 1, '10:00', '18:00'),
	(3, 1, '10:00', '18:00'),
	(4, 1, '10:00', '18:00'),
	(5, 1, '10:00', '18:00'),
	(6, 0, NULL, NULL),
	(7, 0, NULL, NULL);
