CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    ai_nickname TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);
