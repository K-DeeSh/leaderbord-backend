import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'scores.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL,
    login TEXT NOT NULL,
    score INTEGER NOT NULL,
    victory INTEGER,
    archetype TEXT,
    difficulty TEXT,
    turns INTEGER,
    duration_seconds INTEGER,
    metrics TEXT,
    stats TEXT,
    is_suspicious INTEGER DEFAULT 0,
    suspicious_reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    game_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_game_score ON scores(game_id, score DESC, is_suspicious);
  CREATE INDEX IF NOT EXISTS idx_login ON scores(login);
`);

// Add columns to existing DB if they don't exist yet (idempotent migrations)
for (const sql of [
  `ALTER TABLE scores ADD COLUMN is_suspicious INTEGER DEFAULT 0`,
  `ALTER TABLE scores ADD COLUMN suspicious_reason TEXT`,
]) {
  try { db.exec(sql); } catch { /* column already exists */ }
}

// Retroactively mark implausibly-high scores as suspicious
db.exec(`
  UPDATE scores SET is_suspicious = 1, suspicious_reason = 'score_too_high_retroactive'
  WHERE is_suspicious = 0
    AND (
      (game_id = 'cto_simulator'    AND score > 1000) OR
      (game_id = 'last_mile_collapse' AND score > 250)
    )
`);

export default db;
