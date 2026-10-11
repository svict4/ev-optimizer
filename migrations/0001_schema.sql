-- The whole D1 schema in one migration. Every statement is idempotent
-- (IF NOT EXISTS / INSERT OR IGNORE), so it also applies cleanly to a
-- database built by the earlier per-step migrations: existing tables and
-- config values are left alone, and only the never-used leftovers at the
-- end are removed. SPEC.md "Data model" describes each table.

-- Runtime settings changed without a redeploy (README "Configuration").
-- home_lat/home_lon are required and seeded at setup; the rest default in
-- code when the row is absent (shadow_mode on, solar_track/solar_soak/
-- soak_export on, glide_mode asap, home_detection gps).
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO config (key, value) VALUES
  ('safety_factor', '1.3'),
  ('stranded_min_pct', '30');

-- One row per local day: the morning plan and the persisted state-machine
-- snapshot (state_json = StoredState from src/tick.ts; state is the
-- human-readable name for dashboards).
CREATE TABLE IF NOT EXISTS days (
  date TEXT PRIMARY KEY,          -- YYYY-MM-DD local
  reserve_pct INTEGER NOT NULL,
  planned_at TEXT NOT NULL,       -- ISO timestamp
  state TEXT NOT NULL,            -- current state machine state
  state_json TEXT
);

-- Every tick that does anything writes a row with the inputs it acted on.
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  state_from TEXT NOT NULL,
  state_to TEXT NOT NULL,
  action TEXT NOT NULL,           -- e.g. start_charging:16, set_amps:12, none
  inputs_json TEXT NOT NULL       -- snapshot of every input the decision used
);

-- Half-hour house load history, the reserve forecast's input (nightly pull
-- and /backfill, EV charging slots excluded at ingest).
CREATE TABLE IF NOT EXISTS load_samples (
  date TEXT NOT NULL,             -- YYYY-MM-DD local
  slot_half_hour INTEGER NOT NULL,-- 0..47
  load_kwh REAL NOT NULL,
  PRIMARY KEY (date, slot_half_hour)
);

-- Latest "car is home" report from a bluetooth scanner (or any webhook),
-- written by POST /presence and read by the tick when config
-- home_detection uses bluetooth (src/presence.ts). Single row.
CREATE TABLE IF NOT EXISTS presence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  home INTEGER NOT NULL,          -- 1 = car seen, 0 = car not seen
  reported_at TEXT NOT NULL,      -- ISO timestamp (Worker clock)
  source TEXT                     -- free text from the reporter, for the log
);

-- Leftovers from the per-step migrations, never read or written: the
-- operating window comes from wrangler.jsonc vars, the evening dump was
-- never built, and session ownership lives in days.state_json.
DELETE FROM config WHERE key IN ('evening_dump', 'window_start_local', 'window_end_local');
DROP TABLE IF EXISTS sessions;
