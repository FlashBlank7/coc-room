CREATE TABLE modules_with_revision_history (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  source_text TEXT NOT NULL,
  module_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id, revision)
);

INSERT INTO modules_with_revision_history (
  id,
  revision,
  title,
  schema_version,
  source_text,
  module_json,
  created_at,
  updated_at
)
SELECT
  id,
  CAST(COALESCE(json_extract(module_json, '$.revision'), 1) AS INTEGER),
  title,
  schema_version,
  source_text,
  module_json,
  created_at,
  updated_at
FROM modules;

DROP TABLE modules;
ALTER TABLE modules_with_revision_history RENAME TO modules;

CREATE INDEX idx_modules_latest_revision ON modules(id, revision DESC);
