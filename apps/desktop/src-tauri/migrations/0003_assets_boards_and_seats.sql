PRAGMA foreign_keys = ON;

-- Binary payloads live in the application data directory. SQLite stores only
-- validated metadata and references; no source paths or payload bytes belong
-- in this database.
CREATE TABLE assets (
  asset_id TEXT PRIMARY KEY NOT NULL
    CHECK (
      length(asset_id) = 71
      AND substr(asset_id, 1, 7) = 'sha256:'
      AND substr(asset_id, 8) NOT GLOB '*[^0-9a-f]*'
    ),
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'audio')),
  media_type TEXT NOT NULL
    CHECK (media_type IN ('image/webp', 'audio/mpeg', 'audio/ogg', 'audio/wav')),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 67108864),
  pixel_width INTEGER,
  pixel_height INTEGER,
  storage_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  CHECK (
    (
      media_kind = 'image'
      AND media_type = 'image/webp'
      AND byte_length <= 8388608
      AND pixel_width BETWEEN 1 AND 8192
      AND pixel_height BETWEEN 1 AND 8192
      AND pixel_width * pixel_height <= 32000000
    )
    OR
    (
      media_kind = 'audio'
      AND media_type IN ('audio/mpeg', 'audio/ogg', 'audio/wav')
      AND pixel_width IS NULL
      AND pixel_height IS NULL
    )
  )
);

-- Polymorphic references deliberately point only toward assets. Owner rows
-- may be a module revision, room, board, location, NPC, handout or character.
-- The owner type remains extensible without another schema rewrite.
CREATE TABLE asset_refs (
  asset_id TEXT NOT NULL,
  owner_type TEXT NOT NULL CHECK (length(owner_type) BETWEEN 1 AND 64),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 240),
  owner_revision INTEGER NOT NULL DEFAULT 0 CHECK (owner_revision >= 0),
  slot TEXT NOT NULL CHECK (length(slot) BETWEEN 1 AND 120),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_type, owner_id, owner_revision, slot, asset_id),
  FOREIGN KEY (asset_id) REFERENCES assets(asset_id) ON DELETE RESTRICT
);
CREATE INDEX idx_asset_refs_asset ON asset_refs(asset_id);

-- A grant is an append-only record that a room event made an asset available
-- to the whole room or a future peer/seat audience. Revocation cannot retract
-- bytes already downloaded, so historical grants continue to retain assets.
CREATE TABLE asset_grants (
  room_id TEXT NOT NULL,
  asset_id TEXT NOT NULL
    CHECK (
      length(asset_id) = 71
      AND substr(asset_id, 1, 7) = 'sha256:'
      AND substr(asset_id, 8) NOT GLOB '*[^0-9a-f]*'
    ),
  audience_kind TEXT NOT NULL CHECK (audience_kind IN ('room', 'peer', 'seat')),
  audience_id TEXT NOT NULL CHECK (length(audience_id) BETWEEN 1 AND 240),
  granted_sequence INTEGER NOT NULL CHECK (granted_sequence > 0),
  revoked_sequence INTEGER CHECK (
    revoked_sequence IS NULL OR revoked_sequence > granted_sequence
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, asset_id, audience_kind, audience_id, granted_sequence),
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);
CREATE INDEX idx_asset_grants_asset ON asset_grants(asset_id);
CREATE INDEX idx_asset_grants_room_sequence
  ON asset_grants(room_id, granted_sequence);

-- Incomplete downloads are resumable and may refer to an asset that is not
-- present in the completed assets table yet. temp_storage_key is interpreted
-- only by the Rust asset store and is never exposed as an arbitrary path.
CREATE TABLE asset_downloads (
  room_id TEXT NOT NULL,
  asset_id TEXT NOT NULL
    CHECK (
      length(asset_id) = 71
      AND substr(asset_id, 1, 7) = 'sha256:'
      AND substr(asset_id, 8) NOT GLOB '*[^0-9a-f]*'
    ),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  source_peer_id TEXT NOT NULL CHECK (length(source_peer_id) BETWEEN 8 AND 64),
  total_bytes INTEGER NOT NULL CHECK (total_bytes > 0 AND total_bytes <= 67108864),
  chunk_size INTEGER NOT NULL CHECK (chunk_size BETWEEN 1024 AND 65536),
  chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 1 AND 65536),
  received_chunks_json TEXT NOT NULL CHECK (json_valid(received_chunks_json)),
  temp_storage_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'receiving', 'verifying', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_id, asset_id),
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);
CREATE INDEX idx_asset_downloads_updated ON asset_downloads(updated_at);

-- Board snapshots are disposable materialized projections. Confirmed room
-- events remain the authority and can rebuild a missing or stale snapshot.
CREATE TABLE board_snapshots (
  room_id TEXT NOT NULL,
  board_id TEXT NOT NULL CHECK (length(board_id) BETWEEN 1 AND 240),
  through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0),
  board_revision INTEGER NOT NULL CHECK (board_revision > 0),
  snapshot_version INTEGER NOT NULL CHECK (snapshot_version > 0),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, board_id, through_sequence),
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);
CREATE INDEX idx_board_snapshots_latest
  ON board_snapshots(room_id, board_id, through_sequence DESC);

-- The actual derived verifier is held by Windows Credential Manager. This
-- table intentionally contains only non-secret version metadata.
CREATE TABLE room_seat_verifiers (
  room_id TEXT NOT NULL,
  seat_id TEXT NOT NULL CHECK (length(seat_id) BETWEEN 1 AND 64),
  kdf_version INTEGER NOT NULL CHECK (kdf_version = 1),
  proof_version INTEGER NOT NULL CHECK (proof_version = 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_id, seat_id),
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);
