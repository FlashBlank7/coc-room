-- Parsed or manually repaired modules remain drafts until the keeper explicitly
-- saves them into the versioned module library. Draft IDs are independent of
-- module IDs so a future editor can keep more than one recovery point.
CREATE TABLE module_drafts (
  draft_id TEXT PRIMARY KEY NOT NULL,
  module_json TEXT NOT NULL CHECK (json_valid(module_json)),
  source_text TEXT NOT NULL,
  source_name TEXT NOT NULL,
  warnings_json TEXT NOT NULL CHECK (json_valid(warnings_json)),
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_module_drafts_updated_at
  ON module_drafts(updated_at DESC, draft_id ASC);
