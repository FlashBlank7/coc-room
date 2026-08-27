PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  local_role TEXT NOT NULL CHECK (local_role IN ('host', 'player')),
  local_peer_id TEXT NOT NULL,
  host_peer_id TEXT NOT NULL,
  invite_token TEXT NOT NULL,
  join_token TEXT,
  relay_url TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_events (
  room_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (room_id, event_id),
  UNIQUE (room_id, seq),
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_room_events_sequence ON room_events(room_id, seq);

CREATE TABLE IF NOT EXISTS characters (
  room_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  owner_peer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  character_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_id, character_id),
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS modules (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  source_text TEXT NOT NULL,
  module_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
