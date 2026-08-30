-- Exact descriptors are part of the authorization decision. Asset IDs alone
-- are insufficient because a guessed hash paired with forged MIME or size
-- metadata must never become a valid download grant.
ALTER TABLE asset_grants ADD COLUMN descriptor_json TEXT
  CHECK (descriptor_json IS NULL OR json_valid(descriptor_json));

CREATE INDEX idx_asset_grants_exact_seat
  ON asset_grants(room_id, audience_kind, audience_id, asset_id, descriptor_json);

-- Partial downloads retain the exact descriptor that was authorized. Payload
-- chunks remain in an application-managed temporary file, never in SQLite.
ALTER TABLE asset_downloads ADD COLUMN descriptor_json TEXT
  CHECK (descriptor_json IS NULL OR json_valid(descriptor_json));

