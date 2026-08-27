import Database from "@tauri-apps/plugin-sql";
import {
  modulePackageSchema,
  roomEventSchema,
  type ModulePackageV1,
  type RoomEventV1,
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
}

export interface StoredModule {
  package: ModulePackageV1;
  sourceText: string;
}

export interface LocalRepository {
  saveRoom(room: RoomRecord): Promise<void>;
  listRooms(): Promise<RoomRecord[]>;
  saveEvent(event: RoomEventV1): Promise<boolean>;
  listEvents(roomId: string, afterSequence?: number): Promise<RoomEventV1[]>;
  saveModule(value: StoredModule): Promise<void>;
  listModules(): Promise<StoredModule[]>;
  deleteModule(moduleId: string): Promise<void>;
  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;
}

function assertNewerModuleRevision(existing: ModulePackageV1 | undefined, candidate: ModulePackageV1): void {
  if (existing && candidate.revision <= existing.revision) {
    throw new Error(`模组修订号必须高于已保存的 v${existing.revision}`);
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

class SqliteRepository implements LocalRepository {
  private constructor(private readonly db: Database) {}

  static async open(): Promise<SqliteRepository> {
    return new SqliteRepository(await Database.load("sqlite:coc-room.db"));
  }

  async saveRoom(room: RoomRecord): Promise<void> {
    await this.db.execute(
      `INSERT INTO rooms (id, name, local_role, local_peer_id, host_peer_id, invite_token, join_token, relay_url, last_seq, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, local_role=excluded.local_role,
       local_peer_id=excluded.local_peer_id, host_peer_id=excluded.host_peer_id,
       invite_token=excluded.invite_token, join_token=excluded.join_token, relay_url=excluded.relay_url,
       last_seq=MAX(rooms.last_seq, excluded.last_seq),
       updated_at=excluded.updated_at`,
      [room.id, room.name, room.localRole, room.localPeerId, room.hostPeerId, room.inviteToken, room.joinToken ?? null, room.relayUrl, room.lastSeq, room.createdAt, room.updatedAt],
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
    }));
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

  async saveModule(value: StoredModule): Promise<void> {
    const modulePackage = modulePackageSchema.parse(value.package);
    const existingRows = await this.db.select<Array<{ module_json: string }>>(
      "SELECT module_json FROM modules WHERE id=?",
      [modulePackage.moduleId],
    );
    const existing = existingRows[0]
      ? modulePackageSchema.parse(JSON.parse(existingRows[0].module_json))
      : undefined;
    assertNewerModuleRevision(existing, modulePackage);
    await this.db.execute(
      `INSERT INTO modules (id, title, schema_version, source_text, module_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, schema_version=excluded.schema_version,
       source_text=excluded.source_text, module_json=excluded.module_json, updated_at=excluded.updated_at`,
      [modulePackage.moduleId, modulePackage.metadata.title, modulePackage.schemaVersion, value.sourceText, JSON.stringify(modulePackage), modulePackage.metadata.createdAt, modulePackage.metadata.updatedAt],
    );
  }

  async listModules(): Promise<StoredModule[]> {
    const rows = await this.db.select<Array<{ module_json: string; source_text: string }>>(
      "SELECT module_json, source_text FROM modules ORDER BY updated_at DESC",
    );
    return rows.map((row) => ({ package: modulePackageSchema.parse(JSON.parse(row.module_json)), sourceText: row.source_text }));
  }

  async deleteModule(moduleId: string): Promise<void> {
    await this.db.execute("DELETE FROM modules WHERE id=?", [moduleId]);
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
  private readonly modules = new Map<string, StoredModule>();
  private readonly settings = new Map<string, string>();

  async saveRoom(room: RoomRecord): Promise<void> {
    const existing = this.rooms.get(room.id);
    this.rooms.set(room.id, structuredClone({
      ...room,
      createdAt: existing?.createdAt ?? room.createdAt,
      lastSeq: Math.max(existing?.lastSeq ?? 0, room.lastSeq),
    }));
  }
  async listRooms(): Promise<RoomRecord[]> {
    return [...this.rooms.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
  async saveModule(value: StoredModule): Promise<void> {
    const modulePackage = modulePackageSchema.parse(value.package);
    const existing = this.modules.get(modulePackage.moduleId);
    assertNewerModuleRevision(existing?.package, modulePackage);
    this.modules.set(modulePackage.moduleId, structuredClone({ package: modulePackage, sourceText: value.sourceText }));
  }
  async listModules(): Promise<StoredModule[]> {
    return [...this.modules.values()]
      .map((value) => structuredClone(value))
      .sort((a, b) => b.package.metadata.updatedAt.localeCompare(a.package.metadata.updatedAt));
  }
  async deleteModule(moduleId: string): Promise<void> {
    this.modules.delete(moduleId);
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
  repositoryPromise ??= isTauriRuntime() ? SqliteRepository.open() : Promise.resolve(new MemoryRepository());
  return repositoryPromise;
}
