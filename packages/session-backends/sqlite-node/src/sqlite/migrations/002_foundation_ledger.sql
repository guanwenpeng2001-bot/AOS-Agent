CREATE TABLE IF NOT EXISTS foundation_records (
	session_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	payload TEXT NOT NULL,
	PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS foundation_writer_leases (
	session_id TEXT PRIMARY KEY,
	lease_revision INTEGER NOT NULL,
	payload TEXT NOT NULL
) WITHOUT ROWID;
