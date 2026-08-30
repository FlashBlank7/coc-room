PRAGMA foreign_keys = ON;

-- V1 rows remain protocol_version=1 and are never rewritten in place. V2
-- rooms use stable seat IDs; credentials themselves stay in the OS keyring.
ALTER TABLE rooms ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1
  CHECK (protocol_version IN (1, 2));
ALTER TABLE rooms ADD COLUMN local_seat_id TEXT;
ALTER TABLE rooms ADD COLUMN host_seat_id TEXT;
ALTER TABLE rooms ADD COLUMN seat_credential_version INTEGER NOT NULL DEFAULT 1
  CHECK (seat_credential_version > 0);

CREATE TABLE room_seats_v2 (
  room_id TEXT NOT NULL,
  seat_id TEXT NOT NULL CHECK (length(seat_id) BETWEEN 1 AND 64),
  role TEXT NOT NULL CHECK (role IN ('host', 'player')),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  last_peer_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_id, seat_id),
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);
CREATE INDEX idx_room_seats_v2_room_role ON room_seats_v2(room_id, role);

-- Only a host stores this table. It is the full authority log used to rebuild
-- the sequencer; player installations never receive these payloads.
CREATE TABLE room_authority_events_v2 (
  room_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),
  occurred_at TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  PRIMARY KEY (room_id, event_id),
  UNIQUE (room_id, seq),
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);
CREATE INDEX idx_room_authority_events_v2_sequence
  ON room_authority_events_v2(room_id, seq);

-- This is the only V2 event table present on a player projection path.
-- Redacted JSON contains only room/event IDs, sequence and timestamp: never
-- an event type, payload, audience, sender or asset digest.
CREATE TABLE room_event_views_v2 (
  room_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),
  visibility TEXT NOT NULL CHECK (visibility IN ('full', 'redacted')),
  occurred_at TEXT NOT NULL,
  view_json TEXT NOT NULL CHECK (json_valid(view_json)),
  PRIMARY KEY (room_id, event_id),
  UNIQUE (room_id, seq),
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);
CREATE INDEX idx_room_event_views_v2_sequence
  ON room_event_views_v2(room_id, seq);

-- Personal characters are independent of rooms. Private notes and portable
-- avatar references are therefore never mixed into room-wide character events.
CREATE TABLE personal_characters_v2 (
  character_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  character_json TEXT NOT NULL CHECK (json_valid(character_json)),
  private_notes TEXT NOT NULL DEFAULT '',
  avatar_asset_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (avatar_asset_id) REFERENCES assets(asset_id) ON DELETE RESTRICT
);
CREATE INDEX idx_personal_characters_v2_updated
  ON personal_characters_v2(updated_at DESC);
