import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import {
  assetDescriptorV1Schema,
  coc7CharacterSchema,
  modulePackageSchema,
  roomEventV2Schema,
  roomEventViewV2Schema,
  roomEventSchema,
  seatV2Schema,
  type Coc7Character,
  type AssetDescriptorV1,
  type ModulePackageV1,
  type RoomEventV1,
  type RoomEventV2,
  type RoomEventViewV2,
  type SeatV2,
} from "@coc-room/protocol";

export interface RoomRecord {
  id: string;
  name: string;
  localRole: "host" | "player";
  localPeerId: string;
  hostPeerId: string;
  inviteToken: string;
  joinToken?: string;
  relayUrl: string;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
  /** Missing on legacy rows and fixtures; callers must treat it as V1. */
  protocolVersion?: 1 | 2;
  localSeatId?: string;
  hostSeatId?: string;
  seatCredentialVersion?: number;
}

export interface RoomSeatRecordV2 {
  roomId: string;
  seat: SeatV2;
  credentialVersion: number;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalCharacterV2 {
  characterId: string;
  revision: number;
  character: Coc7Character;
  privateNotes: string;
  avatarAssetId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssetGrantV2 {
  roomId: string;
  seatId: string;
  asset: AssetDescriptorV1;
  grantedSequence: number;
  createdAt: string;
}

export interface StoredModule {
  package: ModulePackageV1;
  sourceText: string;
}

export interface StoredModuleDraft {
  draftId: string;
  package: ModulePackageV1;
  sourceText: string;
  sourceName: string;
  warnings: string[];
  updatedAt: string;
}

export interface ModuleListOptions {
  /** The library normally shows one card per module. Set false to inspect revision history. */
  latestOnly?: boolean;
  moduleId?: string;
}

export interface LocalRepository {
  saveRoom(room: RoomRecord): Promise<void>;
  listRooms(): Promise<RoomRecord[]>;
  deleteRoom(roomId: string): Promise<void>;
  saveEvent(event: RoomEventV1): Promise<boolean>;
  listEvents(roomId: string, afterSequence?: number): Promise<RoomEventV1[]>;
  saveAuthorityEventV2(event: RoomEventV2): Promise<boolean>;
  listAuthorityEventsV2(roomId: string, afterSequence?: number): Promise<RoomEventV2[]>;
  saveEventViewV2(view: RoomEventViewV2): Promise<"inserted" | "upgraded" | "duplicate">;
  listEventViewsV2(roomId: string, afterSequence?: number): Promise<RoomEventViewV2[]>;
  saveSeatV2(record: RoomSeatRecordV2): Promise<void>;
  listSeatsV2(roomId: string): Promise<RoomSeatRecordV2[]>;
  saveAssetGrantV2(grant: AssetGrantV2): Promise<void>;
  hasAssetGrantV2(roomId: string, seatId: string, asset: AssetDescriptorV1): Promise<boolean>;
  savePersonalCharacterV2(record: PersonalCharacterV2): Promise<void>;
  listPersonalCharactersV2(): Promise<PersonalCharacterV2[]>;
  deletePersonalCharacterV2(characterId: string): Promise<void>;
  saveModule(value: StoredModule): Promise<void>;
  getModule(moduleId: string, revision?: number): Promise<StoredModule | undefined>;
  listModules(options?: ModuleListOptions): Promise<StoredModule[]>;
  deleteModule(moduleId: string): Promise<void>;
  deleteModuleRevision(moduleId: string, revision: number): Promise<void>;
  saveModuleDraft(value: StoredModuleDraft): Promise<void>;
  getModuleDraft(draftId: string): Promise<StoredModuleDraft | undefined>;
  listModuleDrafts(): Promise<StoredModuleDraft[]>;
  deleteModuleDraft(draftId: string): Promise<void>;
  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;
}

export function parseStoredModuleDraft(candidate: StoredModuleDraft): StoredModuleDraft {
  const modulePackage = modulePackageSchema.parse(candidate.package);
  if (!candidate.draftId) throw new Error("Module draft ID is required");
  if (!Array.isArray(candidate.warnings) || candidate.warnings.some((warning) => typeof warning !== "string")) {
    throw new Error("Module draft warnings must be strings");
  }
  if (!Number.isFinite(Date.parse(candidate.updatedAt))) {
    throw new Error("Module draft updatedAt must be an ISO date-time string");
  }
  return structuredClone({
    ...candidate,
    package: modulePackage,
    warnings: [...candidate.warnings],
  });
}

function assertNewerModuleRevision(existing: ModulePackageV1 | undefined, candidate: ModulePackageV1): void {
  if (existing && candidate.revision <= existing.revision) {
    throw new Error(`模组修订号必须高于已保存的 v${existing.revision}`);
  }
}

function assertRoomProtocolVersionUnchanged(
  existing: Pick<RoomRecord, "protocolVersion"> | undefined,
  candidate: Pick<RoomRecord, "protocolVersion">,
): void {
  if (existing && (existing.protocolVersion ?? 1) !== (candidate.protocolVersion ?? 1)) {
    throw new Error("房间协议版本不可原地改写；V1 房间只能只读打开和导出");
  }
}

function eventViewMetadataV2(view: RoomEventViewV2): {
  roomId: string;
  eventId: string;
  sequence: number;
  occurredAt: string;
  visibility: "full" | "redacted";
} {
  return view.view === "full"
    ? {
        roomId: view.event.roomId,
        eventId: view.event.eventId,
        sequence: view.event.sequence,
        occurredAt: view.event.occurredAt,
        visibility: "full",
      }
    : {
        roomId: view.roomId,
        eventId: view.eventId,
        sequence: view.sequence,
        occurredAt: view.occurredAt,
        visibility: "redacted",
      };
}

function parsePersonalCharacterV2(candidate: PersonalCharacterV2): PersonalCharacterV2 {
  const character = coc7CharacterSchema.parse(candidate.character);
  if (candidate.characterId !== character.id) {
    throw new Error("个人角色库 ID 必须与角色卡 ID 一致");
  }
  if (!Number.isInteger(candidate.revision) || candidate.revision < 1) {
    throw new Error("个人角色修订号必须是正整数");
  }
  if (candidate.privateNotes.length > 100_000) throw new Error("角色私人笔记过长");
  if (candidate.avatarAssetId && !/^sha256:[0-9a-f]{64}$/.test(candidate.avatarAssetId)) {
    throw new Error("角色头像资源 ID 无效");
  }
  return {
    ...candidate,
    character,
  };
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

async function initializeSmokeSchema(db: Database): Promise<void> {
  // Alternate smoke databases do not pass through the plugin's default-db
  // migration hook. Keep this deliberately limited to the room tables used by
  // the two-process session diagnostic.
  await db.execute("PRAGMA foreign_keys = ON");
  await db.execute(`
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
      updated_at TEXT NOT NULL,
      protocol_version INTEGER NOT NULL DEFAULT 1,
      local_seat_id TEXT,
      host_seat_id TEXT
      ,seat_credential_version INTEGER NOT NULL DEFAULT 1
    )
  `);
  await db.execute(`
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
    )
  `);
  await db.execute("CREATE INDEX IF NOT EXISTS idx_room_events_sequence ON room_events(room_id, seq)");
  await db.execute(`
    CREATE TABLE IF NOT EXISTS room_authority_events_v2 (
      room_id TEXT NOT NULL, event_id TEXT NOT NULL, seq INTEGER NOT NULL,
      occurred_at TEXT NOT NULL, event_json TEXT NOT NULL,
      PRIMARY KEY (room_id, event_id), UNIQUE (room_id, seq)
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS room_event_views_v2 (
      room_id TEXT NOT NULL, event_id TEXT NOT NULL, seq INTEGER NOT NULL,
      visibility TEXT NOT NULL, occurred_at TEXT NOT NULL, view_json TEXT NOT NULL,
      PRIMARY KEY (room_id, event_id), UNIQUE (room_id, seq)
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS room_seats_v2 (
      room_id TEXT NOT NULL, seat_id TEXT NOT NULL, role TEXT NOT NULL,
      display_name TEXT NOT NULL, credential_version INTEGER NOT NULL,
      disabled INTEGER NOT NULL, last_peer_id TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY (room_id, seat_id)
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS personal_characters_v2 (
      character_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL,
      character_json TEXT NOT NULL, private_notes TEXT NOT NULL,
      avatar_asset_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS module_drafts (
      draft_id TEXT PRIMARY KEY NOT NULL,
      module_json TEXT NOT NULL CHECK (json_valid(module_json)),
      source_text TEXT NOT NULL,
      source_name TEXT NOT NULL,
      warnings_json TEXT NOT NULL CHECK (json_valid(warnings_json)),
      updated_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS asset_grants (
      room_id TEXT NOT NULL, asset_id TEXT NOT NULL,
      audience_kind TEXT NOT NULL, audience_id TEXT NOT NULL,
      granted_sequence INTEGER NOT NULL, revoked_sequence INTEGER,
      created_at TEXT NOT NULL, descriptor_json TEXT,
      PRIMARY KEY (room_id, asset_id, audience_kind, audience_id, granted_sequence)
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS asset_downloads (
      room_id TEXT NOT NULL, asset_id TEXT NOT NULL, request_id TEXT NOT NULL,
      source_peer_id TEXT NOT NULL, total_bytes INTEGER NOT NULL,
      chunk_size INTEGER NOT NULL, chunk_count INTEGER NOT NULL,
      received_chunks_json TEXT NOT NULL, temp_storage_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      descriptor_json TEXT, PRIMARY KEY (room_id, asset_id)
    )
  `);
}

class SqliteRepository implements LocalRepository {
  private constructor(private readonly db: Database) {}

  static async open(): Promise<SqliteRepository> {
    let databaseName = "coc-room.db";
    if (isTauriRuntime()) {
      const smokeDatabase = await invoke<string | null>("network_smoke_database");
      if (smokeDatabase) databaseName = smokeDatabase;
    }
    const db = await Database.load(`sqlite:${databaseName}`);
    if (databaseName !== "coc-room.db") await initializeSmokeSchema(db);
    return new SqliteRepository(db);
  }

  async saveRoom(room: RoomRecord): Promise<void> {
    const existing = await this.db.select<Array<{ protocol_version: number }>>(
      "SELECT protocol_version FROM rooms WHERE id=? LIMIT 1",
      [room.id],
    );
    assertRoomProtocolVersionUnchanged(
      existing[0] ? { protocolVersion: Number(existing[0].protocol_version ?? 1) as 1 | 2 } : undefined,
      room,
    );
    await this.db.execute(
      `INSERT INTO rooms (id, name, local_role, local_peer_id, host_peer_id, invite_token, join_token, relay_url, last_seq, created_at, updated_at, protocol_version, local_seat_id, host_seat_id, seat_credential_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, local_role=excluded.local_role,
       local_peer_id=excluded.local_peer_id, host_peer_id=excluded.host_peer_id,
       invite_token=excluded.invite_token, join_token=excluded.join_token, relay_url=excluded.relay_url,
       local_seat_id=excluded.local_seat_id, host_seat_id=excluded.host_seat_id,
       seat_credential_version=excluded.seat_credential_version,
       last_seq=MAX(rooms.last_seq, excluded.last_seq),
       updated_at=excluded.updated_at`,
      [room.id, room.name, room.localRole, room.localPeerId, room.hostPeerId, room.inviteToken, room.joinToken ?? null, room.relayUrl, room.lastSeq, room.createdAt, room.updatedAt, room.protocolVersion ?? 1, room.localSeatId ?? null, room.hostSeatId ?? null, room.seatCredentialVersion ?? 1],
    );
  }

  async listRooms(): Promise<RoomRecord[]> {
    const rows = await this.db.select<Array<Record<string, unknown>>>(
      "SELECT * FROM rooms ORDER BY updated_at DESC",
    );
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      localRole: row.local_role as "host" | "player",
      localPeerId: String(row.local_peer_id),
      hostPeerId: String(row.host_peer_id),
      inviteToken: String(row.invite_token),
      ...(row.join_token ? { joinToken: String(row.join_token) } : {}),
      relayUrl: String(row.relay_url),
      lastSeq: Number(row.last_seq),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      protocolVersion: Number(row.protocol_version ?? 1) as 1 | 2,
      ...(row.local_seat_id ? { localSeatId: String(row.local_seat_id) } : {}),
      ...(row.host_seat_id ? { hostSeatId: String(row.host_seat_id) } : {}),
      seatCredentialVersion: Number(row.seat_credential_version ?? 1),
    }));
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.db.execute("DELETE FROM rooms WHERE id=?", [roomId]);
  }

  async saveEvent(candidate: RoomEventV1): Promise<boolean> {
    const event = roomEventSchema.parse(candidate);
    const serialized = JSON.stringify(event);
    const inspectExisting = async (): Promise<boolean> => {
      const rows = await this.db.select<Array<{ event_id: string; seq: number; event_json: string }>>(
        `SELECT event_id, seq, event_json FROM room_events
         WHERE room_id=? AND (event_id=? OR seq=?)`,
        [event.roomId, event.eventId, event.sequence],
      );
      if (rows.length === 0) return false;
      if (
        rows.length === 1 &&
        rows[0]?.event_id === event.eventId &&
        Number(rows[0].seq) === event.sequence &&
        JSON.stringify(roomEventSchema.parse(JSON.parse(rows[0].event_json))) === serialized
      ) {
        return true;
      }
      throw new Error(`房间 ${event.roomId} 的事件 ID 或序号与已有日志冲突`);
    };
    if (await inspectExisting()) return false;

    let result;
    try {
      result = await this.db.execute(
        `INSERT INTO room_events
         (room_id, event_id, seq, event_type, sender_id, created_at, event_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [event.roomId, event.eventId, event.sequence, event.type, event.sender.peerId, event.occurredAt, serialized],
      );
    } catch (error) {
      if (await inspectExisting()) return false;
      throw error;
    }
    if (result.rowsAffected > 0) {
      await this.db.execute(
        "UPDATE rooms SET last_seq=MAX(last_seq, ?), updated_at=? WHERE id=?",
        [event.sequence, new Date().toISOString(), event.roomId],
      );
      return true;
    }
    return false;
  }

  async listEvents(roomId: string, afterSequence = 0): Promise<RoomEventV1[]> {
    const rows = await this.db.select<Array<{ event_json: string }>>(
      "SELECT event_json FROM room_events WHERE room_id=? AND seq>? ORDER BY seq ASC",
      [roomId, afterSequence],
    );
    return rows.map((row) => roomEventSchema.parse(JSON.parse(row.event_json)));
  }

  async saveAuthorityEventV2(candidate: RoomEventV2): Promise<boolean> {
    const event = roomEventV2Schema.parse(candidate);
    const serialized = JSON.stringify(event);
    const existing = await this.db.select<Array<{ event_id: string; seq: number; event_json: string }>>(
      `SELECT event_id, seq, event_json FROM room_authority_events_v2
       WHERE room_id=? AND (event_id=? OR seq=?)`,
      [event.roomId, event.eventId, event.sequence],
    );
    if (existing.length > 0) {
      if (
        existing.length === 1 &&
        existing[0]?.event_id === event.eventId &&
        Number(existing[0].seq) === event.sequence &&
        JSON.stringify(roomEventV2Schema.parse(JSON.parse(existing[0].event_json))) === serialized
      ) return false;
      throw new Error(`房间 ${event.roomId} 的 V2 权威事件 ID 或序号冲突`);
    }

    const view = roomEventViewV2Schema.parse({ view: "full", event });
    try {
      await this.db.execute("BEGIN IMMEDIATE");
      await this.db.execute(
        `INSERT INTO room_authority_events_v2 (room_id, event_id, seq, occurred_at, event_json)
         VALUES (?, ?, ?, ?, ?)`,
        [event.roomId, event.eventId, event.sequence, event.occurredAt, serialized],
      );
      await this.db.execute(
        `INSERT INTO room_event_views_v2
         (room_id, event_id, seq, visibility, occurred_at, view_json)
         VALUES (?, ?, ?, 'full', ?, ?)
         ON CONFLICT(room_id, event_id) DO UPDATE SET
           visibility='full', occurred_at=excluded.occurred_at, view_json=excluded.view_json
         WHERE room_event_views_v2.seq=excluded.seq
           AND room_event_views_v2.visibility='redacted'`,
        [event.roomId, event.eventId, event.sequence, event.occurredAt, JSON.stringify(view)],
      );
      await this.db.execute(
        "UPDATE rooms SET last_seq=MAX(last_seq, ?), updated_at=? WHERE id=? AND protocol_version=2",
        [event.sequence, new Date().toISOString(), event.roomId],
      );
      await this.db.execute("COMMIT");
      return true;
    } catch (error) {
      await this.db.execute("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  async listAuthorityEventsV2(roomId: string, afterSequence = 0): Promise<RoomEventV2[]> {
    const rows = await this.db.select<Array<{ event_json: string }>>(
      `SELECT event_json FROM room_authority_events_v2
       WHERE room_id=? AND seq>? ORDER BY seq ASC`,
      [roomId, afterSequence],
    );
    return rows.map(({ event_json }) => roomEventV2Schema.parse(JSON.parse(event_json)));
  }

  async saveEventViewV2(candidate: RoomEventViewV2): Promise<"inserted" | "upgraded" | "duplicate"> {
    const view = roomEventViewV2Schema.parse(candidate);
    const metadata = eventViewMetadataV2(view);
    const serialized = JSON.stringify(view);
    const rows = await this.db.select<Array<{
      event_id: string;
      seq: number;
      visibility: "full" | "redacted";
      view_json: string;
    }>>(
      `SELECT event_id, seq, visibility, view_json FROM room_event_views_v2
       WHERE room_id=? AND (event_id=? OR seq=?)`,
      [metadata.roomId, metadata.eventId, metadata.sequence],
    );
    const existing = rows[0];
    if (existing !== undefined) {
      if (rows.length !== 1 || existing.event_id !== metadata.eventId || Number(existing.seq) !== metadata.sequence) {
        throw new Error(`房间 ${metadata.roomId} 的 V2 视图 ID 或序号冲突`);
      }
      const current = roomEventViewV2Schema.parse(JSON.parse(existing.view_json));
      if (JSON.stringify(current) === serialized) return "duplicate";
      if (existing.visibility !== "redacted" || metadata.visibility !== "full") {
        throw new Error("V2 完整事件视图不能被修改或降级");
      }
      await this.db.execute(
        `UPDATE room_event_views_v2
         SET visibility='full', occurred_at=?, view_json=?
         WHERE room_id=? AND event_id=? AND seq=? AND visibility='redacted'`,
        [metadata.occurredAt, serialized, metadata.roomId, metadata.eventId, metadata.sequence],
      );
      return "upgraded";
    }
    await this.db.execute(
      `INSERT INTO room_event_views_v2
       (room_id, event_id, seq, visibility, occurred_at, view_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [metadata.roomId, metadata.eventId, metadata.sequence, metadata.visibility, metadata.occurredAt, serialized],
    );
    await this.db.execute(
      "UPDATE rooms SET last_seq=MAX(last_seq, ?), updated_at=? WHERE id=? AND protocol_version=2",
      [metadata.sequence, new Date().toISOString(), metadata.roomId],
    );
    return "inserted";
  }

  async listEventViewsV2(roomId: string, afterSequence = 0): Promise<RoomEventViewV2[]> {
    const rows = await this.db.select<Array<{ view_json: string }>>(
      `SELECT view_json FROM room_event_views_v2
       WHERE room_id=? AND seq>? ORDER BY seq ASC`,
      [roomId, afterSequence],
    );
    return rows.map(({ view_json }) => roomEventViewV2Schema.parse(JSON.parse(view_json)));
  }

  async saveSeatV2(candidate: RoomSeatRecordV2): Promise<void> {
    const seat = seatV2Schema.parse(candidate.seat);
    if (!Number.isInteger(candidate.credentialVersion) || candidate.credentialVersion < 1) {
      throw new Error("席位凭据版本无效");
    }
    await this.db.execute(
      `INSERT INTO room_seats_v2
       (room_id, seat_id, role, display_name, credential_version, disabled, last_peer_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(room_id, seat_id) DO UPDATE SET
         role=excluded.role, display_name=excluded.display_name,
         credential_version=excluded.credential_version, disabled=excluded.disabled,
         last_peer_id=excluded.last_peer_id, updated_at=excluded.updated_at`,
      [candidate.roomId, seat.seatId, seat.role, seat.displayName, candidate.credentialVersion, candidate.disabled ? 1 : 0, seat.peerId ?? null, candidate.createdAt, candidate.updatedAt],
    );
  }

  async listSeatsV2(roomId: string): Promise<RoomSeatRecordV2[]> {
    const rows = await this.db.select<Array<Record<string, unknown>>>(
      "SELECT * FROM room_seats_v2 WHERE room_id=? ORDER BY role ASC, created_at ASC",
      [roomId],
    );
    return rows.map((row) => ({
      roomId,
      seat: seatV2Schema.parse({
        seatId: String(row.seat_id),
        role: row.role,
        displayName: String(row.display_name),
        ...(row.last_peer_id ? { peerId: String(row.last_peer_id) } : {}),
        extensions: {},
      }),
      credentialVersion: Number(row.credential_version),
      disabled: Number(row.disabled) === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  async saveAssetGrantV2(candidate: AssetGrantV2): Promise<void> {
    const asset = assetDescriptorV1Schema.parse(candidate.asset);
    if (!candidate.seatId || candidate.seatId.length > 64) throw new Error("Asset grant seat ID is invalid");
    if (!Number.isInteger(candidate.grantedSequence) || candidate.grantedSequence < 1) {
      throw new Error("Asset grant sequence is invalid");
    }
    const descriptorJson = JSON.stringify(asset);
    const inserted = await this.db.execute(
      `INSERT INTO asset_grants
       (room_id, asset_id, audience_kind, audience_id, granted_sequence,
        revoked_sequence, created_at, descriptor_json)
       VALUES (?, ?, 'seat', ?, ?, NULL, ?, ?)
       ON CONFLICT(room_id, asset_id, audience_kind, audience_id, granted_sequence)
       DO NOTHING`,
      [candidate.roomId, asset.assetId, candidate.seatId, candidate.grantedSequence, candidate.createdAt, descriptorJson],
    );
    if (inserted.rowsAffected > 0) return;
    const existing = await this.db.select<Array<{ descriptor_json: string | null }>>(
      `SELECT descriptor_json FROM asset_grants
       WHERE room_id=? AND asset_id=? AND audience_kind='seat'
         AND audience_id=? AND granted_sequence=?`,
      [candidate.roomId, asset.assetId, candidate.seatId, candidate.grantedSequence],
    );
    if (existing[0]?.descriptor_json === descriptorJson) return;
    throw new Error("Asset grant key was reused with a different descriptor");
  }

  async hasAssetGrantV2(roomId: string, seatId: string, candidate: AssetDescriptorV1): Promise<boolean> {
    const asset = assetDescriptorV1Schema.parse(candidate);
    const rows = await this.db.select<Array<{ granted: number }>>(
      `SELECT 1 AS granted FROM asset_grants
       WHERE room_id=? AND asset_id=? AND audience_kind='seat' AND audience_id=?
         AND descriptor_json=? LIMIT 1`,
      [roomId, asset.assetId, seatId, JSON.stringify(asset)],
    );
    return rows.length > 0;
  }

  async savePersonalCharacterV2(candidate: PersonalCharacterV2): Promise<void> {
    const record = parsePersonalCharacterV2(candidate);
    const rows = await this.db.select<Array<{ revision: number; character_json: string; private_notes: string; avatar_asset_id?: string }>>(
      "SELECT revision, character_json, private_notes, avatar_asset_id FROM personal_characters_v2 WHERE character_id=?",
      [record.characterId],
    );
    const existing = rows[0];
    if (existing !== undefined) {
      const identical = Number(existing.revision) === record.revision
        && JSON.stringify(coc7CharacterSchema.parse(JSON.parse(existing.character_json))) === JSON.stringify(record.character)
        && existing.private_notes === record.privateNotes
        && (existing.avatar_asset_id ?? undefined) === record.avatarAssetId;
      if (identical) return;
      if (record.revision !== Number(existing.revision) + 1) {
        throw new Error(`个人角色修订冲突：期望 v${Number(existing.revision) + 1}`);
      }
    } else if (record.revision !== 1) {
      throw new Error("新个人角色必须从 v1 开始");
    }
    await this.db.execute(
      `INSERT INTO personal_characters_v2
       (character_id, revision, character_json, private_notes, avatar_asset_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(character_id) DO UPDATE SET
         revision=excluded.revision, character_json=excluded.character_json,
         private_notes=excluded.private_notes, avatar_asset_id=excluded.avatar_asset_id,
         updated_at=excluded.updated_at`,
      [record.characterId, record.revision, JSON.stringify(record.character), record.privateNotes, record.avatarAssetId ?? null, record.createdAt, record.updatedAt],
    );
  }

  async listPersonalCharactersV2(): Promise<PersonalCharacterV2[]> {
    const rows = await this.db.select<Array<Record<string, unknown>>>(
      "SELECT * FROM personal_characters_v2 ORDER BY updated_at DESC",
    );
    return rows.map((row) => parsePersonalCharacterV2({
      characterId: String(row.character_id),
      revision: Number(row.revision),
      character: coc7CharacterSchema.parse(JSON.parse(String(row.character_json))),
      privateNotes: String(row.private_notes),
      ...(row.avatar_asset_id ? { avatarAssetId: String(row.avatar_asset_id) } : {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  async deletePersonalCharacterV2(characterId: string): Promise<void> {
    await this.db.execute("DELETE FROM personal_characters_v2 WHERE character_id=?", [characterId]);
  }

  async saveModule(value: StoredModule): Promise<void> {
    const modulePackage = modulePackageSchema.parse(value.package);
    const existingRows = await this.db.select<Array<{ module_json: string }>>(
      "SELECT module_json FROM modules WHERE id=? ORDER BY revision DESC LIMIT 1",
      [modulePackage.moduleId],
    );
    const existing = existingRows[0]
      ? modulePackageSchema.parse(JSON.parse(existingRows[0].module_json))
      : undefined;
    assertNewerModuleRevision(existing, modulePackage);
    await this.db.execute(
      `INSERT INTO modules (id, revision, title, schema_version, source_text, module_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [modulePackage.moduleId, modulePackage.revision, modulePackage.metadata.title, modulePackage.schemaVersion, value.sourceText, JSON.stringify(modulePackage), modulePackage.metadata.createdAt, modulePackage.metadata.updatedAt],
    );
  }

  async getModule(moduleId: string, revision?: number): Promise<StoredModule | undefined> {
    const rows = revision === undefined
      ? await this.db.select<Array<{ module_json: string; source_text: string }>>(
          "SELECT module_json, source_text FROM modules WHERE id=? ORDER BY revision DESC LIMIT 1",
          [moduleId],
        )
      : await this.db.select<Array<{ module_json: string; source_text: string }>>(
          "SELECT module_json, source_text FROM modules WHERE id=? AND revision=? LIMIT 1",
          [moduleId, revision],
        );
    const row = rows[0];
    return row
      ? { package: modulePackageSchema.parse(JSON.parse(row.module_json)), sourceText: row.source_text }
      : undefined;
  }

  async listModules(options: ModuleListOptions = {}): Promise<StoredModule[]> {
    const { latestOnly = true, moduleId } = options;
    const params = moduleId ? [moduleId] : [];
    const filter = moduleId ? "WHERE id=?" : "";
    const query = latestOnly
      ? `SELECT module_json, source_text
         FROM (
           SELECT id, updated_at, module_json, source_text,
                  ROW_NUMBER() OVER (PARTITION BY id ORDER BY revision DESC) AS revision_rank
           FROM modules ${filter}
         )
         WHERE revision_rank=1
         ORDER BY updated_at DESC, id ASC`
      : `SELECT module_json, source_text FROM modules ${filter}
         ORDER BY ${moduleId ? "revision DESC" : "updated_at DESC, id ASC, revision DESC"}`;
    const rows = await this.db.select<Array<{ module_json: string; source_text: string }>>(
      query,
      params,
    );
    return rows.map((row) => ({ package: modulePackageSchema.parse(JSON.parse(row.module_json)), sourceText: row.source_text }));
  }

  async deleteModule(moduleId: string): Promise<void> {
    await this.db.execute("DELETE FROM modules WHERE id=?", [moduleId]);
  }

  async deleteModuleRevision(moduleId: string, revision: number): Promise<void> {
    await this.db.execute("DELETE FROM modules WHERE id=? AND revision=?", [moduleId, revision]);
  }

  async saveModuleDraft(candidate: StoredModuleDraft): Promise<void> {
    const draft = parseStoredModuleDraft(candidate);
    await this.db.execute(
      `INSERT INTO module_drafts
       (draft_id, module_json, source_text, source_name, warnings_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(draft_id) DO UPDATE SET
         module_json=excluded.module_json,
         source_text=excluded.source_text,
         source_name=excluded.source_name,
         warnings_json=excluded.warnings_json,
         updated_at=excluded.updated_at`,
      [
        draft.draftId,
        JSON.stringify(draft.package),
        draft.sourceText,
        draft.sourceName,
        JSON.stringify(draft.warnings),
        draft.updatedAt,
      ],
    );
  }

  async getModuleDraft(draftId: string): Promise<StoredModuleDraft | undefined> {
    const rows = await this.db.select<Array<{
      draft_id: string;
      module_json: string;
      source_text: string;
      source_name: string;
      warnings_json: string;
      updated_at: string;
    }>>(
      `SELECT draft_id, module_json, source_text, source_name, warnings_json, updated_at
       FROM module_drafts WHERE draft_id=? LIMIT 1`,
      [draftId],
    );
    const row = rows[0];
    return row
      ? parseStoredModuleDraft({
          draftId: row.draft_id,
          package: modulePackageSchema.parse(JSON.parse(row.module_json)),
          sourceText: row.source_text,
          sourceName: row.source_name,
          warnings: JSON.parse(row.warnings_json) as string[],
          updatedAt: row.updated_at,
        })
      : undefined;
  }

  async listModuleDrafts(): Promise<StoredModuleDraft[]> {
    const rows = await this.db.select<Array<{
      draft_id: string;
      module_json: string;
      source_text: string;
      source_name: string;
      warnings_json: string;
      updated_at: string;
    }>>(
      `SELECT draft_id, module_json, source_text, source_name, warnings_json, updated_at
       FROM module_drafts ORDER BY updated_at DESC, draft_id ASC`,
    );
    return rows.map((row) => parseStoredModuleDraft({
      draftId: row.draft_id,
      package: modulePackageSchema.parse(JSON.parse(row.module_json)),
      sourceText: row.source_text,
      sourceName: row.source_name,
      warnings: JSON.parse(row.warnings_json) as string[],
      updatedAt: row.updated_at,
    }));
  }

  async deleteModuleDraft(draftId: string): Promise<void> {
    await this.db.execute("DELETE FROM module_drafts WHERE draft_id=?", [draftId]);
  }

  async getSetting(key: string): Promise<string | undefined> {
    const rows = await this.db.select<Array<{ value: string }>>("SELECT value FROM app_settings WHERE key=?", [key]);
    return rows[0]?.value;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.execute(
      "INSERT INTO app_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [key, value],
    );
  }
}

export class MemoryRepository implements LocalRepository {
  private readonly rooms = new Map<string, RoomRecord>();
  private readonly events = new Map<string, Map<string, RoomEventV1>>();
  private readonly authorityEventsV2 = new Map<string, Map<string, RoomEventV2>>();
  private readonly eventViewsV2 = new Map<string, Map<number, RoomEventViewV2>>();
  private readonly seatsV2 = new Map<string, Map<string, RoomSeatRecordV2>>();
  private readonly assetGrantsV2 = new Map<string, AssetGrantV2>();
  private readonly personalCharactersV2 = new Map<string, PersonalCharacterV2>();
  private readonly modules = new Map<string, Map<number, StoredModule>>();
  private readonly moduleDrafts = new Map<string, StoredModuleDraft>();
  private readonly settings = new Map<string, string>();

  async saveRoom(room: RoomRecord): Promise<void> {
    const existing = this.rooms.get(room.id);
    assertRoomProtocolVersionUnchanged(existing, room);
    this.rooms.set(room.id, structuredClone({
      ...room,
      createdAt: existing?.createdAt ?? room.createdAt,
      lastSeq: Math.max(existing?.lastSeq ?? 0, room.lastSeq),
    }));
  }
  async listRooms(): Promise<RoomRecord[]> {
    return [...this.rooms.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async deleteRoom(roomId: string): Promise<void> {
    this.rooms.delete(roomId);
    this.events.delete(roomId);
    this.authorityEventsV2.delete(roomId);
    this.eventViewsV2.delete(roomId);
    this.seatsV2.delete(roomId);
    for (const [key, grant] of this.assetGrantsV2) {
      if (grant.roomId === roomId) this.assetGrantsV2.delete(key);
    }
  }
  async saveEvent(candidate: RoomEventV1): Promise<boolean> {
    const event = roomEventSchema.parse(candidate);
    const room = this.rooms.get(event.roomId);
    if (!room) {
      throw new Error(`Room ${event.roomId} must be saved before its events`);
    }
    const roomEvents = this.events.get(event.roomId) ?? new Map<string, RoomEventV1>();
    const sameId = roomEvents.get(event.eventId);
    if (sameId) {
      if (JSON.stringify(sameId) === JSON.stringify(event)) return false;
      throw new Error(`事件 ID ${event.eventId} 被重用为不同内容`);
    }
    const sameSequence = [...roomEvents.values()].find((item) => item.sequence === event.sequence);
    if (sameSequence) {
      throw new Error(`序号 ${event.sequence} 已被事件 ${sameSequence.eventId} 占用`);
    }
    roomEvents.set(event.eventId, structuredClone(event));
    this.events.set(event.roomId, roomEvents);
    this.rooms.set(event.roomId, {
      ...room,
      lastSeq: Math.max(room.lastSeq, event.sequence),
      updatedAt: new Date().toISOString(),
    });
    return true;
  }
  async listEvents(roomId: string, afterSequence = 0): Promise<RoomEventV1[]> {
    return [...(this.events.get(roomId)?.values() ?? [])]
      .filter((event) => event.sequence > afterSequence)
      .sort((a, b) => a.sequence - b.sequence);
  }
  async saveAuthorityEventV2(candidate: RoomEventV2): Promise<boolean> {
    const event = roomEventV2Schema.parse(candidate);
    const room = this.rooms.get(event.roomId);
    if (!room || (room.protocolVersion ?? 1) !== 2) {
      throw new Error(`V2 room ${event.roomId} must be saved before its events`);
    }
    const roomEvents = this.authorityEventsV2.get(event.roomId) ?? new Map<string, RoomEventV2>();
    const sameId = roomEvents.get(event.eventId);
    if (sameId !== undefined) {
      if (JSON.stringify(sameId) === JSON.stringify(event)) return false;
      throw new Error(`V2 事件 ID ${event.eventId} 被重用为不同内容`);
    }
    const sameSequence = [...roomEvents.values()].find((item) => item.sequence === event.sequence);
    if (sameSequence) throw new Error(`V2 序号 ${event.sequence} 已被占用`);
    roomEvents.set(event.eventId, structuredClone(event));
    this.authorityEventsV2.set(event.roomId, roomEvents);
    await this.saveEventViewV2({ view: "full", event });
    return true;
  }
  async listAuthorityEventsV2(roomId: string, afterSequence = 0): Promise<RoomEventV2[]> {
    return [...(this.authorityEventsV2.get(roomId)?.values() ?? [])]
      .filter(({ sequence }) => sequence > afterSequence)
      .sort((left, right) => left.sequence - right.sequence)
      .map((event) => structuredClone(event));
  }
  async saveEventViewV2(candidate: RoomEventViewV2): Promise<"inserted" | "upgraded" | "duplicate"> {
    const view = roomEventViewV2Schema.parse(candidate);
    const metadata = eventViewMetadataV2(view);
    const room = this.rooms.get(metadata.roomId);
    if (!room || (room.protocolVersion ?? 1) !== 2) {
      throw new Error(`V2 room ${metadata.roomId} must be saved before its views`);
    }
    const views = this.eventViewsV2.get(metadata.roomId) ?? new Map<number, RoomEventViewV2>();
    const existing = views.get(metadata.sequence);
    if (existing !== undefined) {
      const current = eventViewMetadataV2(existing);
      if (current.eventId !== metadata.eventId) throw new Error(`V2 序号 ${metadata.sequence} 已被占用`);
      if (JSON.stringify(existing) === JSON.stringify(view)) return "duplicate";
      if (existing.view !== "redacted" || view.view !== "full") {
        throw new Error("V2 完整事件视图不能被修改或降级");
      }
      views.set(metadata.sequence, structuredClone(view));
      return "upgraded";
    }
    const sameId = [...views.values()].find((item) => eventViewMetadataV2(item).eventId === metadata.eventId);
    if (sameId) throw new Error(`V2 事件 ID ${metadata.eventId} 已存在于其他序号`);
    views.set(metadata.sequence, structuredClone(view));
    this.eventViewsV2.set(metadata.roomId, views);
    this.rooms.set(metadata.roomId, {
      ...room,
      lastSeq: Math.max(room.lastSeq, metadata.sequence),
      updatedAt: new Date().toISOString(),
    });
    return "inserted";
  }
  async listEventViewsV2(roomId: string, afterSequence = 0): Promise<RoomEventViewV2[]> {
    return [...(this.eventViewsV2.get(roomId)?.values() ?? [])]
      .filter((view) => eventViewMetadataV2(view).sequence > afterSequence)
      .sort((left, right) => eventViewMetadataV2(left).sequence - eventViewMetadataV2(right).sequence)
      .map((view) => structuredClone(view));
  }
  async saveSeatV2(candidate: RoomSeatRecordV2): Promise<void> {
    const seat = seatV2Schema.parse(candidate.seat);
    if (!this.rooms.has(candidate.roomId)) throw new Error(`Room ${candidate.roomId} must be saved first`);
    if (!Number.isInteger(candidate.credentialVersion) || candidate.credentialVersion < 1) {
      throw new Error("席位凭据版本无效");
    }
    const roomSeats = this.seatsV2.get(candidate.roomId) ?? new Map<string, RoomSeatRecordV2>();
    roomSeats.set(seat.seatId, structuredClone({ ...candidate, seat }));
    this.seatsV2.set(candidate.roomId, roomSeats);
  }
  async listSeatsV2(roomId: string): Promise<RoomSeatRecordV2[]> {
    return [...(this.seatsV2.get(roomId)?.values() ?? [])]
      .map((seat) => structuredClone(seat))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  async saveAssetGrantV2(candidate: AssetGrantV2): Promise<void> {
    const grant: AssetGrantV2 = {
      ...candidate,
      asset: assetDescriptorV1Schema.parse(candidate.asset),
    };
    if (!this.rooms.has(grant.roomId)) throw new Error(`Room ${grant.roomId} must be saved first`);
    if (!grant.seatId || grant.seatId.length > 64) throw new Error("Asset grant seat ID is invalid");
    if (!Number.isInteger(grant.grantedSequence) || grant.grantedSequence < 1) {
      throw new Error("Asset grant sequence is invalid");
    }
    const key = `${grant.roomId}\u0000${grant.asset.assetId}\u0000${grant.seatId}\u0000${grant.grantedSequence}`;
    const existing = this.assetGrantsV2.get(key);
    if (existing !== undefined) {
      if (JSON.stringify(existing.asset) === JSON.stringify(grant.asset)) return;
      throw new Error("Asset grant key was reused with different content");
    }
    this.assetGrantsV2.set(key, structuredClone(grant));
  }
  async hasAssetGrantV2(roomId: string, seatId: string, candidate: AssetDescriptorV1): Promise<boolean> {
    const descriptor = JSON.stringify(assetDescriptorV1Schema.parse(candidate));
    return [...this.assetGrantsV2.values()].some((grant) =>
      grant.roomId === roomId && grant.seatId === seatId && JSON.stringify(grant.asset) === descriptor
    );
  }
  async savePersonalCharacterV2(candidate: PersonalCharacterV2): Promise<void> {
    const record = parsePersonalCharacterV2(candidate);
    const existing = this.personalCharactersV2.get(record.characterId);
    if (existing !== undefined) {
      if (JSON.stringify(existing) === JSON.stringify(record)) return;
      if (record.revision !== existing.revision + 1) {
        throw new Error(`个人角色修订冲突：期望 v${existing.revision + 1}`);
      }
    } else if (record.revision !== 1) {
      throw new Error("新个人角色必须从 v1 开始");
    }
    this.personalCharactersV2.set(record.characterId, structuredClone(record));
  }
  async listPersonalCharactersV2(): Promise<PersonalCharacterV2[]> {
    return [...this.personalCharactersV2.values()]
      .map((record) => structuredClone(record))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  async deletePersonalCharacterV2(characterId: string): Promise<void> {
    this.personalCharactersV2.delete(characterId);
  }
  async saveModule(value: StoredModule): Promise<void> {
    const modulePackage = modulePackageSchema.parse(value.package);
    const revisions = this.modules.get(modulePackage.moduleId) ?? new Map<number, StoredModule>();
    const latest = [...revisions.values()].sort((a, b) => b.package.revision - a.package.revision)[0];
    assertNewerModuleRevision(latest?.package, modulePackage);
    revisions.set(modulePackage.revision, structuredClone({ package: modulePackage, sourceText: value.sourceText }));
    this.modules.set(modulePackage.moduleId, revisions);
  }
  async getModule(moduleId: string, revision?: number): Promise<StoredModule | undefined> {
    const revisions = this.modules.get(moduleId);
    if (!revisions) return undefined;
    const value = revision === undefined
      ? [...revisions.values()].sort((a, b) => b.package.revision - a.package.revision)[0]
      : revisions.get(revision);
    return value ? structuredClone(value) : undefined;
  }
  async listModules(options: ModuleListOptions = {}): Promise<StoredModule[]> {
    const { latestOnly = true, moduleId } = options;
    const revisionGroups = moduleId
      ? [this.modules.get(moduleId) ?? new Map<number, StoredModule>()]
      : [...this.modules.values()];
    const values = revisionGroups.flatMap((revisions) => {
      const ordered = [...revisions.values()].sort((a, b) => b.package.revision - a.package.revision);
      return latestOnly ? ordered.slice(0, 1) : ordered;
    });
    return values
      .map((value) => structuredClone(value))
      .sort((a, b) => moduleId
        ? b.package.revision - a.package.revision
        : b.package.metadata.updatedAt.localeCompare(a.package.metadata.updatedAt)
          || a.package.moduleId.localeCompare(b.package.moduleId)
          || b.package.revision - a.package.revision);
  }
  async deleteModule(moduleId: string): Promise<void> {
    this.modules.delete(moduleId);
  }
  async deleteModuleRevision(moduleId: string, revision: number): Promise<void> {
    const revisions = this.modules.get(moduleId);
    if (!revisions) return;
    revisions.delete(revision);
    if (revisions.size === 0) this.modules.delete(moduleId);
  }
  async saveModuleDraft(candidate: StoredModuleDraft): Promise<void> {
    const draft = parseStoredModuleDraft(candidate);
    this.moduleDrafts.set(draft.draftId, structuredClone(draft));
  }
  async getModuleDraft(draftId: string): Promise<StoredModuleDraft | undefined> {
    const draft = this.moduleDrafts.get(draftId);
    return draft ? parseStoredModuleDraft(draft) : undefined;
  }
  async listModuleDrafts(): Promise<StoredModuleDraft[]> {
    return [...this.moduleDrafts.values()]
      .map((draft) => parseStoredModuleDraft(draft))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.draftId.localeCompare(right.draftId));
  }
  async deleteModuleDraft(draftId: string): Promise<void> {
    this.moduleDrafts.delete(draftId);
  }
  async getSetting(key: string): Promise<string | undefined> {
    return this.settings.get(key);
  }
  async setSetting(key: string, value: string): Promise<void> {
    this.settings.set(key, value);
  }
}

let repositoryPromise: Promise<LocalRepository> | undefined;

export function getRepository(): Promise<LocalRepository> {
  repositoryPromise ??= isTauriRuntime()
    ? SqliteRepository.open()
    : typeof indexedDB !== "undefined"
      ? import("./indexeddb-repository").then(({ IndexedDbRepository }) => IndexedDbRepository.open())
      : Promise.resolve(new MemoryRepository());
  return repositoryPromise;
}

/**
 * Clears only the browser development database. The Tauri SQLite database is
 * deliberately unreachable through this helper.
 *
 * Existing views should reload after this resolves so they do not keep using
 * references to the now-closed repository instance.
 */
export async function clearWebDevelopmentData(): Promise<void> {
  if (isTauriRuntime()) throw new Error("Browser development data cannot clear the Tauri SQLite database");
  repositoryPromise = undefined;
  if (typeof indexedDB === "undefined") return;
  const { clearIndexedDbRepositoryData } = await import("./indexeddb-repository");
  await clearIndexedDbRepositoryData();
}
