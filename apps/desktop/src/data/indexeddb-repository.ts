import {
  assetDescriptorV1Schema,
  coc7CharacterSchema,
  modulePackageSchema,
  roomEventSchema,
  roomEventV2Schema,
  roomEventViewV2Schema,
  seatV2Schema,
  type AssetDescriptorV1,
  type RoomEventV1,
  type RoomEventV2,
  type RoomEventViewV2,
} from "@coc-room/protocol";
import {
  parseStoredModuleDraft,
  type AssetGrantV2,
  type LocalRepository,
  type ModuleListOptions,
  type PersonalCharacterV2,
  type RoomRecord,
  type RoomSeatRecordV2,
  type StoredModule,
  type StoredModuleDraft,
} from "./repository";

export const WEB_REPOSITORY_DATABASE_NAME = "coc-room-web-dev";
export const WEB_REPOSITORY_SCHEMA_VERSION = 3;

const STORE_NAMES = {
  rooms: "rooms",
  eventsV1: "events-v1",
  authorityEventsV2: "authority-events-v2",
  eventViewsV2: "event-views-v2",
  seatsV2: "seats-v2",
  assetGrantsV2: "asset-grants-v2",
  personalCharactersV2: "personal-characters-v2",
  modules: "modules",
  moduleDrafts: "module-drafts",
  settings: "settings",
} as const;

export type WebStoreName = (typeof STORE_NAMES)[keyof typeof STORE_NAMES];
export type TransactionMode = "readonly" | "readwrite";

export interface StoredValue<T> {
  key: string;
  value: T;
}

export interface WebRepositoryTransaction {
  get<T>(storeName: WebStoreName, key: string): Promise<T | undefined>;
  getAll<T>(storeName: WebStoreName): Promise<Array<StoredValue<T>>>;
  put<T>(storeName: WebStoreName, key: string, value: T): Promise<void>;
  delete(storeName: WebStoreName, key: string): Promise<void>;
}

export interface WebRepositoryStorage {
  transaction<T>(
    storeNames: WebStoreName[],
    mode: TransactionMode,
    operation: (transaction: WebRepositoryTransaction) => Promise<T>,
  ): Promise<T>;
  close(): void;
}

type Migration = {
  version: number;
  stores: WebStoreName[];
};

/** Kept explicit so future schema changes can upgrade existing browser databases in place. */
export const WEB_REPOSITORY_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    stores: [STORE_NAMES.rooms, STORE_NAMES.eventsV1, STORE_NAMES.modules, STORE_NAMES.settings],
  },
  {
    version: 2,
    stores: [
      STORE_NAMES.authorityEventsV2,
      STORE_NAMES.eventViewsV2,
      STORE_NAMES.seatsV2,
      STORE_NAMES.assetGrantsV2,
      STORE_NAMES.personalCharactersV2,
    ],
  },
  {
    version: 3,
    stores: [STORE_NAMES.moduleDrafts],
  },
] as const;

const activeDatabases = new Set<IDBDatabase>();

function clone<T>(value: T): T {
  return structuredClone(value);
}

function compositeKey(...parts: Array<string | number>): string {
  return parts.map((part) => {
    const text = String(part);
    return `${text.length}:${text}`;
  }).join("|");
}

function eventViewMetadata(view: RoomEventViewV2): {
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

function parsePersonalCharacter(candidate: PersonalCharacterV2): PersonalCharacterV2 {
  const character = coc7CharacterSchema.parse(candidate.character);
  if (candidate.characterId !== character.id) {
    throw new Error("Personal character ID must match the character sheet ID");
  }
  if (!Number.isInteger(candidate.revision) || candidate.revision < 1) {
    throw new Error("Personal character revision must be a positive integer");
  }
  if (candidate.privateNotes.length > 100_000) throw new Error("Personal character notes are too long");
  if (candidate.avatarAssetId && !/^sha256:[0-9a-f]{64}$/.test(candidate.avatarAssetId)) {
    throw new Error("Personal character avatar asset ID is invalid");
  }
  return { ...candidate, character };
}

function assertRoomProtocolVersionUnchanged(existing: RoomRecord | undefined, candidate: RoomRecord): void {
  if (existing && (existing.protocolVersion ?? 1) !== (candidate.protocolVersion ?? 1)) {
    throw new Error("Room protocol version cannot be rewritten in place; V1 rooms remain read-only");
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionFinished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

class BrowserIndexedDbStorage implements WebRepositoryStorage {
  constructor(private readonly database: IDBDatabase) {}

  async transaction<T>(
    storeNames: WebStoreName[],
    mode: TransactionMode,
    operation: (transaction: WebRepositoryTransaction) => Promise<T>,
  ): Promise<T> {
    const transaction = this.database.transaction(storeNames, mode);
    const finished = transactionFinished(transaction);
    const adapter: WebRepositoryTransaction = {
      get: async <Value>(storeName: WebStoreName, key: string) => {
        const record = await requestResult(
          transaction.objectStore(storeName).get(key) as IDBRequest<StoredValue<Value> | undefined>,
        );
        return record === undefined ? undefined : clone(record.value);
      },
      getAll: async <Value>(storeName: WebStoreName) => {
        const records = await requestResult(
          transaction.objectStore(storeName).getAll() as IDBRequest<Array<StoredValue<Value>>>,
        );
        return records.map((record) => clone(record));
      },
      put: async <Value>(storeName: WebStoreName, key: string, value: Value) => {
        await requestResult(transaction.objectStore(storeName).put({ key, value: clone(value) }));
      },
      delete: async (storeName: WebStoreName, key: string) => {
        await requestResult(transaction.objectStore(storeName).delete(key));
      },
    };

    try {
      const result = await operation(adapter);
      await finished;
      return result;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The request may already have aborted the transaction.
      }
      await finished.catch(() => undefined);
      throw error;
    }
  }

  close(): void {
    activeDatabases.delete(this.database);
    this.database.close();
  }
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(WEB_REPOSITORY_DATABASE_NAME, WEB_REPOSITORY_SCHEMA_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
      for (const migration of WEB_REPOSITORY_MIGRATIONS) {
        if (migration.version <= oldVersion) continue;
        for (const storeName of migration.stores) {
          if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName, { keyPath: "key" });
        }
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        activeDatabases.delete(database);
        database.close();
      };
      activeDatabases.add(database);
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error("Unable to open the browser database"));
    request.onblocked = () => reject(new Error("Browser database upgrade is blocked by another CoC Room tab"));
  });
}

async function deleteDatabase(factory: IDBFactory): Promise<void> {
  for (const database of activeDatabases) database.close();
  activeDatabases.clear();
  await new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(WEB_REPOSITORY_DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Unable to clear the browser database"));
    request.onblocked = () => reject(new Error("Close other CoC Room tabs before clearing browser data"));
  });
}

export class IndexedDbRepository implements LocalRepository {
  constructor(private readonly storage: WebRepositoryStorage) {}

  static async open(factory: IDBFactory = indexedDB): Promise<IndexedDbRepository> {
    return new IndexedDbRepository(new BrowserIndexedDbStorage(await openDatabase(factory)));
  }

  close(): void {
    this.storage.close();
  }

  async saveRoom(candidate: RoomRecord): Promise<void> {
    const room = clone(candidate);
    await this.storage.transaction([STORE_NAMES.rooms], "readwrite", async (transaction) => {
      const existing = await transaction.get<RoomRecord>(STORE_NAMES.rooms, room.id);
      assertRoomProtocolVersionUnchanged(existing, room);
      await transaction.put(STORE_NAMES.rooms, room.id, {
        ...room,
        createdAt: existing?.createdAt ?? room.createdAt,
        lastSeq: Math.max(existing?.lastSeq ?? 0, room.lastSeq),
      });
    });
  }

  async listRooms(): Promise<RoomRecord[]> {
    return this.storage.transaction([STORE_NAMES.rooms], "readonly", async (transaction) =>
      (await transaction.getAll<RoomRecord>(STORE_NAMES.rooms))
        .map(({ value }) => value)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(clone));
  }

  async deleteRoom(roomId: string): Promise<void> {
    const roomScopedStores = [
      STORE_NAMES.eventsV1,
      STORE_NAMES.authorityEventsV2,
      STORE_NAMES.eventViewsV2,
      STORE_NAMES.seatsV2,
      STORE_NAMES.assetGrantsV2,
    ];
    await this.storage.transaction([STORE_NAMES.rooms, ...roomScopedStores], "readwrite", async (transaction) => {
      await transaction.delete(STORE_NAMES.rooms, roomId);
      for (const storeName of roomScopedStores) {
        for (const record of await transaction.getAll<{ roomId: string }>(storeName)) {
          if (record.value.roomId === roomId) await transaction.delete(storeName, record.key);
        }
      }
    });
  }

  async saveEvent(candidate: RoomEventV1): Promise<boolean> {
    const event = roomEventSchema.parse(candidate);
    return this.storage.transaction([STORE_NAMES.rooms, STORE_NAMES.eventsV1], "readwrite", async (transaction) => {
      const room = await transaction.get<RoomRecord>(STORE_NAMES.rooms, event.roomId);
      if (!room) throw new Error(`Room ${event.roomId} must be saved before its events`);
      const events = (await transaction.getAll<RoomEventV1>(STORE_NAMES.eventsV1))
        .map(({ value }) => value)
        .filter((stored) => stored.roomId === event.roomId);
      const sameId = events.find((stored) => stored.eventId === event.eventId);
      if (sameId) {
        if (JSON.stringify(sameId) === JSON.stringify(event)) return false;
        throw new Error(`Event ID ${event.eventId} was reused with different content`);
      }
      const sameSequence = events.find((stored) => stored.sequence === event.sequence);
      if (sameSequence) throw new Error(`Sequence ${event.sequence} is already occupied by ${sameSequence.eventId}`);
      await transaction.put(STORE_NAMES.eventsV1, compositeKey(event.roomId, event.eventId), event);
      await transaction.put(STORE_NAMES.rooms, room.id, {
        ...room,
        lastSeq: Math.max(room.lastSeq, event.sequence),
        updatedAt: new Date().toISOString(),
      });
      return true;
    });
  }

  async listEvents(roomId: string, afterSequence = 0): Promise<RoomEventV1[]> {
    return this.storage.transaction([STORE_NAMES.eventsV1], "readonly", async (transaction) =>
      (await transaction.getAll<RoomEventV1>(STORE_NAMES.eventsV1))
        .map(({ value }) => roomEventSchema.parse(value))
        .filter((event) => event.roomId === roomId && event.sequence > afterSequence)
        .sort((left, right) => left.sequence - right.sequence));
  }

  async saveAuthorityEventV2(candidate: RoomEventV2): Promise<boolean> {
    const event = roomEventV2Schema.parse(candidate);
    return this.storage.transaction(
      [STORE_NAMES.rooms, STORE_NAMES.authorityEventsV2, STORE_NAMES.eventViewsV2],
      "readwrite",
      async (transaction) => {
        const room = await transaction.get<RoomRecord>(STORE_NAMES.rooms, event.roomId);
        if (!room || (room.protocolVersion ?? 1) !== 2) {
          throw new Error(`V2 room ${event.roomId} must be saved before its events`);
        }
        const authorityEvents = (await transaction.getAll<RoomEventV2>(STORE_NAMES.authorityEventsV2))
          .map(({ value }) => value)
          .filter((stored) => stored.roomId === event.roomId);
        const sameId = authorityEvents.find((stored) => stored.eventId === event.eventId);
        if (sameId) {
          if (JSON.stringify(sameId) === JSON.stringify(event)) return false;
          throw new Error(`V2 event ID ${event.eventId} was reused with different content`);
        }
        if (authorityEvents.some((stored) => stored.sequence === event.sequence)) {
          throw new Error(`V2 sequence ${event.sequence} is already occupied`);
        }

        const fullView = roomEventViewV2Schema.parse({ view: "full", event });
        const views = (await transaction.getAll<RoomEventViewV2>(STORE_NAMES.eventViewsV2))
          .filter(({ value }) => eventViewMetadata(value).roomId === event.roomId);
        const viewConflict = views.find(({ value }) => {
          const metadata = eventViewMetadata(value);
          return metadata.eventId === event.eventId || metadata.sequence === event.sequence;
        });
        if (viewConflict) {
          const metadata = eventViewMetadata(viewConflict.value);
          if (metadata.eventId !== event.eventId || metadata.sequence !== event.sequence) {
            throw new Error("V2 authority event conflicts with an existing projected view");
          }
          if (JSON.stringify(viewConflict.value) !== JSON.stringify(fullView)) {
            if (viewConflict.value.view !== "redacted") {
              throw new Error("An existing full V2 event view cannot be modified");
            }
            await transaction.put(STORE_NAMES.eventViewsV2, viewConflict.key, fullView);
          }
        } else {
          await transaction.put(STORE_NAMES.eventViewsV2, compositeKey(event.roomId, event.eventId), fullView);
        }
        await transaction.put(STORE_NAMES.authorityEventsV2, compositeKey(event.roomId, event.eventId), event);
        await transaction.put(STORE_NAMES.rooms, room.id, {
          ...room,
          lastSeq: Math.max(room.lastSeq, event.sequence),
          updatedAt: new Date().toISOString(),
        });
        return true;
      },
    );
  }

  async listAuthorityEventsV2(roomId: string, afterSequence = 0): Promise<RoomEventV2[]> {
    return this.storage.transaction([STORE_NAMES.authorityEventsV2], "readonly", async (transaction) =>
      (await transaction.getAll<RoomEventV2>(STORE_NAMES.authorityEventsV2))
        .map(({ value }) => roomEventV2Schema.parse(value))
        .filter((event) => event.roomId === roomId && event.sequence > afterSequence)
        .sort((left, right) => left.sequence - right.sequence));
  }

  async saveEventViewV2(candidate: RoomEventViewV2): Promise<"inserted" | "upgraded" | "duplicate"> {
    const view = roomEventViewV2Schema.parse(candidate);
    const metadata = eventViewMetadata(view);
    return this.storage.transaction([STORE_NAMES.rooms, STORE_NAMES.eventViewsV2], "readwrite", async (transaction) => {
      const room = await transaction.get<RoomRecord>(STORE_NAMES.rooms, metadata.roomId);
      if (!room || (room.protocolVersion ?? 1) !== 2) {
        throw new Error(`V2 room ${metadata.roomId} must be saved before its views`);
      }
      const views = (await transaction.getAll<RoomEventViewV2>(STORE_NAMES.eventViewsV2))
        .filter(({ value }) => eventViewMetadata(value).roomId === metadata.roomId);
      const existing = views.find(({ value }) => {
        const stored = eventViewMetadata(value);
        return stored.eventId === metadata.eventId || stored.sequence === metadata.sequence;
      });
      if (existing) {
        const current = eventViewMetadata(existing.value);
        if (current.eventId !== metadata.eventId || current.sequence !== metadata.sequence) {
          throw new Error(`V2 view ID or sequence conflicts in room ${metadata.roomId}`);
        }
        if (JSON.stringify(existing.value) === JSON.stringify(view)) return "duplicate";
        if (existing.value.view !== "redacted" || view.view !== "full") {
          throw new Error("A full V2 event view cannot be modified or downgraded");
        }
        await transaction.put(STORE_NAMES.eventViewsV2, existing.key, view);
        return "upgraded";
      }
      await transaction.put(STORE_NAMES.eventViewsV2, compositeKey(metadata.roomId, metadata.eventId), view);
      await transaction.put(STORE_NAMES.rooms, room.id, {
        ...room,
        lastSeq: Math.max(room.lastSeq, metadata.sequence),
        updatedAt: new Date().toISOString(),
      });
      return "inserted";
    });
  }

  async listEventViewsV2(roomId: string, afterSequence = 0): Promise<RoomEventViewV2[]> {
    return this.storage.transaction([STORE_NAMES.eventViewsV2], "readonly", async (transaction) =>
      (await transaction.getAll<RoomEventViewV2>(STORE_NAMES.eventViewsV2))
        .map(({ value }) => roomEventViewV2Schema.parse(value))
        .filter((view) => {
          const metadata = eventViewMetadata(view);
          return metadata.roomId === roomId && metadata.sequence > afterSequence;
        })
        .sort((left, right) => eventViewMetadata(left).sequence - eventViewMetadata(right).sequence));
  }

  async saveSeatV2(candidate: RoomSeatRecordV2): Promise<void> {
    const seat = seatV2Schema.parse(candidate.seat);
    if (!Number.isInteger(candidate.credentialVersion) || candidate.credentialVersion < 1) {
      throw new Error("Seat credential version is invalid");
    }
    await this.storage.transaction([STORE_NAMES.rooms, STORE_NAMES.seatsV2], "readwrite", async (transaction) => {
      if (!await transaction.get<RoomRecord>(STORE_NAMES.rooms, candidate.roomId)) {
        throw new Error(`Room ${candidate.roomId} must be saved first`);
      }
      const record = clone({ ...candidate, seat });
      await transaction.put(STORE_NAMES.seatsV2, compositeKey(candidate.roomId, seat.seatId), record);
    });
  }

  async listSeatsV2(roomId: string): Promise<RoomSeatRecordV2[]> {
    return this.storage.transaction([STORE_NAMES.seatsV2], "readonly", async (transaction) =>
      (await transaction.getAll<RoomSeatRecordV2>(STORE_NAMES.seatsV2))
        .map(({ value }) => ({ ...value, seat: seatV2Schema.parse(value.seat) }))
        .filter((record) => record.roomId === roomId)
        .sort((left, right) => left.seat.role.localeCompare(right.seat.role) || left.createdAt.localeCompare(right.createdAt))
        .map(clone));
  }

  async saveAssetGrantV2(candidate: AssetGrantV2): Promise<void> {
    const grant: AssetGrantV2 = { ...candidate, asset: assetDescriptorV1Schema.parse(candidate.asset) };
    if (!grant.seatId || grant.seatId.length > 64) throw new Error("Asset grant seat ID is invalid");
    if (!Number.isInteger(grant.grantedSequence) || grant.grantedSequence < 1) {
      throw new Error("Asset grant sequence is invalid");
    }
    await this.storage.transaction([STORE_NAMES.rooms, STORE_NAMES.assetGrantsV2], "readwrite", async (transaction) => {
      if (!await transaction.get<RoomRecord>(STORE_NAMES.rooms, grant.roomId)) {
        throw new Error(`Room ${grant.roomId} must be saved first`);
      }
      const key = compositeKey(grant.roomId, grant.asset.assetId, grant.seatId, grant.grantedSequence);
      const existing = await transaction.get<AssetGrantV2>(STORE_NAMES.assetGrantsV2, key);
      if (existing) {
        if (JSON.stringify(existing.asset) === JSON.stringify(grant.asset)) return;
        throw new Error("Asset grant key was reused with a different descriptor");
      }
      await transaction.put(STORE_NAMES.assetGrantsV2, key, grant);
    });
  }

  async hasAssetGrantV2(roomId: string, seatId: string, candidate: AssetDescriptorV1): Promise<boolean> {
    const descriptor = JSON.stringify(assetDescriptorV1Schema.parse(candidate));
    return this.storage.transaction([STORE_NAMES.assetGrantsV2], "readonly", async (transaction) =>
      (await transaction.getAll<AssetGrantV2>(STORE_NAMES.assetGrantsV2)).some(({ value }) =>
        value.roomId === roomId && value.seatId === seatId && JSON.stringify(value.asset) === descriptor));
  }

  async savePersonalCharacterV2(candidate: PersonalCharacterV2): Promise<void> {
    const record = parsePersonalCharacter(candidate);
    await this.storage.transaction([STORE_NAMES.personalCharactersV2], "readwrite", async (transaction) => {
      const existing = await transaction.get<PersonalCharacterV2>(STORE_NAMES.personalCharactersV2, record.characterId);
      if (existing) {
        const identical = existing.revision === record.revision
          && JSON.stringify(existing.character) === JSON.stringify(record.character)
          && existing.privateNotes === record.privateNotes
          && existing.avatarAssetId === record.avatarAssetId;
        if (identical) return;
        if (record.revision !== existing.revision + 1) {
          throw new Error(`Personal character revision conflict: expected v${existing.revision + 1}`);
        }
      } else if (record.revision !== 1) {
        throw new Error("A new personal character must start at v1");
      }
      await transaction.put(STORE_NAMES.personalCharactersV2, record.characterId, record);
    });
  }

  async listPersonalCharactersV2(): Promise<PersonalCharacterV2[]> {
    return this.storage.transaction([STORE_NAMES.personalCharactersV2], "readonly", async (transaction) =>
      (await transaction.getAll<PersonalCharacterV2>(STORE_NAMES.personalCharactersV2))
        .map(({ value }) => parsePersonalCharacter(value))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(clone));
  }

  async deletePersonalCharacterV2(characterId: string): Promise<void> {
    await this.storage.transaction([STORE_NAMES.personalCharactersV2], "readwrite", (transaction) =>
      transaction.delete(STORE_NAMES.personalCharactersV2, characterId));
  }

  async saveModule(candidate: StoredModule): Promise<void> {
    const modulePackage = modulePackageSchema.parse(candidate.package);
    await this.storage.transaction([STORE_NAMES.modules], "readwrite", async (transaction) => {
      const revisions = (await transaction.getAll<StoredModule>(STORE_NAMES.modules))
        .map(({ value }) => value)
        .filter((stored) => stored.package.moduleId === modulePackage.moduleId);
      const latest = revisions.sort((left, right) => right.package.revision - left.package.revision)[0];
      if (latest && modulePackage.revision <= latest.package.revision) {
        throw new Error(`Module revision must be newer than saved v${latest.package.revision}`);
      }
      await transaction.put(
        STORE_NAMES.modules,
        compositeKey(modulePackage.moduleId, modulePackage.revision),
        { package: modulePackage, sourceText: candidate.sourceText },
      );
    });
  }

  async getModule(moduleId: string, revision?: number): Promise<StoredModule | undefined> {
    const revisions = await this.listModules({ moduleId, latestOnly: false });
    const result = revision === undefined
      ? revisions[0]
      : revisions.find((stored) => stored.package.revision === revision);
    return result ? clone(result) : undefined;
  }

  async listModules(options: ModuleListOptions = {}): Promise<StoredModule[]> {
    const { latestOnly = true, moduleId } = options;
    return this.storage.transaction([STORE_NAMES.modules], "readonly", async (transaction) => {
      const grouped = new Map<string, StoredModule[]>();
      for (const { value } of await transaction.getAll<StoredModule>(STORE_NAMES.modules)) {
        const stored: StoredModule = {
          package: modulePackageSchema.parse(value.package),
          sourceText: value.sourceText,
        };
        if (moduleId && stored.package.moduleId !== moduleId) continue;
        const revisions = grouped.get(stored.package.moduleId) ?? [];
        revisions.push(stored);
        grouped.set(stored.package.moduleId, revisions);
      }
      const values = [...grouped.values()].flatMap((revisions) => {
        revisions.sort((left, right) => right.package.revision - left.package.revision);
        return latestOnly ? revisions.slice(0, 1) : revisions;
      });
      return values
        .sort((left, right) => moduleId
          ? right.package.revision - left.package.revision
          : right.package.metadata.updatedAt.localeCompare(left.package.metadata.updatedAt)
            || left.package.moduleId.localeCompare(right.package.moduleId)
            || right.package.revision - left.package.revision)
        .map(clone);
    });
  }

  async deleteModule(moduleId: string): Promise<void> {
    await this.storage.transaction([STORE_NAMES.modules], "readwrite", async (transaction) => {
      for (const record of await transaction.getAll<StoredModule>(STORE_NAMES.modules)) {
        if (record.value.package.moduleId === moduleId) await transaction.delete(STORE_NAMES.modules, record.key);
      }
    });
  }

  async deleteModuleRevision(moduleId: string, revision: number): Promise<void> {
    await this.storage.transaction([STORE_NAMES.modules], "readwrite", (transaction) =>
      transaction.delete(STORE_NAMES.modules, compositeKey(moduleId, revision)));
  }

  async saveModuleDraft(candidate: StoredModuleDraft): Promise<void> {
    const draft = parseStoredModuleDraft(candidate);
    await this.storage.transaction([STORE_NAMES.moduleDrafts], "readwrite", (transaction) =>
      transaction.put(STORE_NAMES.moduleDrafts, draft.draftId, draft));
  }

  async getModuleDraft(draftId: string): Promise<StoredModuleDraft | undefined> {
    return this.storage.transaction([STORE_NAMES.moduleDrafts], "readonly", async (transaction) => {
      const draft = await transaction.get<StoredModuleDraft>(STORE_NAMES.moduleDrafts, draftId);
      return draft ? parseStoredModuleDraft(draft) : undefined;
    });
  }

  async listModuleDrafts(): Promise<StoredModuleDraft[]> {
    return this.storage.transaction([STORE_NAMES.moduleDrafts], "readonly", async (transaction) =>
      (await transaction.getAll<StoredModuleDraft>(STORE_NAMES.moduleDrafts))
        .map(({ value }) => parseStoredModuleDraft(value))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.draftId.localeCompare(right.draftId)));
  }

  async deleteModuleDraft(draftId: string): Promise<void> {
    await this.storage.transaction([STORE_NAMES.moduleDrafts], "readwrite", (transaction) =>
      transaction.delete(STORE_NAMES.moduleDrafts, draftId));
  }

  async getSetting(key: string): Promise<string | undefined> {
    return this.storage.transaction([STORE_NAMES.settings], "readonly", (transaction) =>
      transaction.get<string>(STORE_NAMES.settings, key));
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.storage.transaction([STORE_NAMES.settings], "readwrite", (transaction) =>
      transaction.put(STORE_NAMES.settings, key, value));
  }
}

export async function clearIndexedDbRepositoryData(factory: IDBFactory = indexedDB): Promise<void> {
  await deleteDatabase(factory);
}
