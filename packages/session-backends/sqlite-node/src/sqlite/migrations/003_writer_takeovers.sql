CREATE TABLE IF NOT EXISTS writer_takeovers (
	session_id TEXT NOT NULL,
	fence INTEGER NOT NULL,
	previous_owner_id TEXT NULL,
	owner_id TEXT NOT NULL,
	previous_fence INTEGER NULL,
	previous_expires_at_ms INTEGER NULL,
	taken_over_at_ms INTEGER NOT NULL,
	reason TEXT NOT NULL,
	PRIMARY KEY (session_id, fence)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_writer_takeovers_session_time
	ON writer_takeovers(session_id, taken_over_at_ms, fence);
