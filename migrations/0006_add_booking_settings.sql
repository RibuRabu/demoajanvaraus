CREATE TABLE IF NOT EXISTS booking_settings (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	same_day_notice_minutes INTEGER NOT NULL,
	buffer_minutes INTEGER NOT NULL,
	slot_interval_minutes INTEGER NOT NULL,
	updated_at_utc TEXT NOT NULL
);

INSERT INTO booking_settings (
	id,
	same_day_notice_minutes,
	buffer_minutes,
	slot_interval_minutes,
	updated_at_utc
)
SELECT
	1,
	120,
	45,
	15,
	CURRENT_TIMESTAMP
WHERE NOT EXISTS (
	SELECT 1
	FROM booking_settings
	WHERE id = 1
);
