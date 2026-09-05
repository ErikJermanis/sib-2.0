import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  EntityPayload,
  EntityType,
  ServerChange,
  SyncOperation,
  SyncResponse,
} from "../shared/protocol.js";
import { hashToken } from "./security.js";

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE shopping_items (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
        position REAL NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        server_version INTEGER NOT NULL
      );

      CREATE TABLE travel_items (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        visited INTEGER NOT NULL CHECK (visited IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        server_version INTEGER NOT NULL
      );

      CREATE TABLE changes (
        version INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL UNIQUE,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('shopping_item', 'travel_item')),
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation = 'upsert'),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT
      );

      CREATE TABLE processed_operations (
        operation_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        server_version INTEGER NOT NULL,
        accepted_at TEXT NOT NULL,
        FOREIGN KEY (device_id) REFERENCES devices(id),
        FOREIGN KEY (server_version) REFERENCES changes(version)
      );

      CREATE TABLE pairing_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        device_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        used_at TEXT
      );

      CREATE INDEX shopping_items_active_position
        ON shopping_items(deleted_at, position);
      CREATE INDEX travel_items_active
        ON travel_items(deleted_at, created_at);
      CREATE INDEX changes_entity
        ON changes(entity_type, entity_id, version);
      CREATE INDEX processed_operations_device
        ON processed_operations(device_id, server_version);
      CREATE INDEX devices_active
        ON devices(revoked_at, created_at);
      CREATE INDEX pairing_tokens_unused
        ON pairing_tokens(used_at, created_at);
    `,
  },
] as const;

export interface DeviceRecord {
  id: string;
  name: string;
}

export interface ListedDevice extends DeviceRecord {
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

interface ChangeRow {
  version: number;
  operation_id: string;
  entity_type: EntityType;
  entity_id: string;
  operation: "upsert";
  payload: string;
}

export function openDatabase(databasePath: string): Database.Database {
  if (databasePath !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }

  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  migrate(database);
  return database;
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  for (const migration of migrations) {
    database.transaction(() => {
      const applied = database
        .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
        .get(migration.version);
      if (applied) return;

      database.exec(migration.sql);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(migration.version, new Date().toISOString());
    }).immediate();
  }
}

export function findDeviceBySessionHash(
  database: Database.Database,
  tokenHash: string,
): DeviceRecord | null {
  const row = database
    .prepare("SELECT id, name FROM devices WHERE token_hash = ? AND revoked_at IS NULL")
    .get(tokenHash) as { id: string; name: string } | undefined;
  return row ?? null;
}

export function touchDevice(database: Database.Database, deviceId: string): void {
  database
    .prepare("UPDATE devices SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), deviceId);
}

export function consumePairingToken(
  database: Database.Database,
  tokenHash: string,
): { device: DeviceRecord; sessionToken: string } | null {
  return database.transaction(() => {
    const pairing = database
      .prepare("SELECT id, device_name FROM pairing_tokens WHERE token_hash = ? AND used_at IS NULL")
      .get(tokenHash) as { id: string; device_name: string } | undefined;
    if (!pairing) return null;

    const now = new Date().toISOString();
    const consumed = database
      .prepare("UPDATE pairing_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL")
      .run(now, pairing.id);
    if (consumed.changes !== 1) return null;

    const sessionToken = randomBytes(32).toString("base64url");
    const device = { id: randomUUID(), name: pairing.device_name };
    database
      .prepare(
        `INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(device.id, device.name, hashToken(sessionToken), now, now);

    return { device, sessionToken };
  }).immediate();
}

export function processSync(
  database: Database.Database,
  deviceId: string,
  operations: SyncOperation[],
  lastSyncVersion: number,
): SyncResponse {
  return database.transaction(() => {
    const currentBefore = currentVersion(database);
    if (lastSyncVersion > currentBefore) {
      throw new FutureCursorError(currentBefore);
    }

    const acceptedOperationIds: string[] = [];
    const seen = new Set<string>();

    for (const operation of operations) {
      if (seen.has(operation.operationId)) continue;
      seen.add(operation.operationId);
      acceptedOperationIds.push(operation.operationId);

      const existing = database
        .prepare("SELECT server_version FROM processed_operations WHERE operation_id = ?")
        .get(operation.operationId);
      if (existing) continue;

      const now = new Date().toISOString();
      const changeResult = database
        .prepare(
          `INSERT INTO changes
            (operation_id, entity_type, entity_id, operation, payload, created_at)
           VALUES (?, ?, ?, 'upsert', ?, ?)`,
        )
        .run(
          operation.operationId,
          operation.entityType,
          operation.entityId,
          JSON.stringify(operation.payload),
          now,
        );
      const serverVersion = Number(changeResult.lastInsertRowid);

      upsertEntity(database, operation.entityType, operation.payload, serverVersion);
      database
        .prepare(
          `INSERT INTO processed_operations
            (operation_id, device_id, server_version, accepted_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(operation.operationId, deviceId, serverVersion, now);
    }

    touchDevice(database, deviceId);
    const changes = database
      .prepare(
        `SELECT version, operation_id, entity_type, entity_id, operation, payload
         FROM changes WHERE version > ? ORDER BY version ASC`,
      )
      .all(lastSyncVersion) as ChangeRow[];

    return {
      acceptedOperationIds,
      changes: changes.map(toServerChange),
      currentSyncVersion: currentVersion(database),
    };
  }).immediate();
}

function upsertEntity(
  database: Database.Database,
  entityType: EntityType,
  payload: EntityPayload,
  serverVersion: number,
): void {
  if (entityType === "shopping_item") {
    const item = payload as Extract<EntityPayload, { completed: boolean }>;
    database
      .prepare(
        `INSERT INTO shopping_items
          (id, text, completed, position, created_at, updated_at, deleted_at, server_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           text = excluded.text,
           completed = excluded.completed,
           position = excluded.position,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at,
           server_version = excluded.server_version`,
      )
      .run(
        item.id,
        item.text,
        Number(item.completed),
        item.position,
        item.createdAt,
        item.updatedAt,
        item.deletedAt,
        serverVersion,
      );
    return;
  }

  const item = payload as Extract<EntityPayload, { visited: boolean }>;
  database
    .prepare(
      `INSERT INTO travel_items
        (id, text, visited, created_at, updated_at, deleted_at, server_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         text = excluded.text,
         visited = excluded.visited,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         deleted_at = excluded.deleted_at,
         server_version = excluded.server_version`,
    )
    .run(
      item.id,
      item.text,
      Number(item.visited),
      item.createdAt,
      item.updatedAt,
      item.deletedAt,
      serverVersion,
    );
}

function currentVersion(database: Database.Database): number {
  const row = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM changes").get() as {
    version: number;
  };
  return row.version;
}

function toServerChange(row: ChangeRow): ServerChange {
  return {
    version: row.version,
    operationId: row.operation_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    operation: row.operation,
    payload: JSON.parse(row.payload) as EntityPayload,
  };
}

export class FutureCursorError extends Error {
  constructor(public readonly currentVersion: number) {
    super("lastSyncVersion is ahead of the server");
    this.name = "FutureCursorError";
  }
}

export function createPairingToken(database: Database.Database, deviceName: string): string {
  const token = randomBytes(32).toString("base64url");
  database
    .prepare(
      `INSERT INTO pairing_tokens (id, token_hash, device_name, created_at, used_at)
       VALUES (?, ?, ?, ?, NULL)`,
    )
    .run(randomUUID(), hashToken(token), deviceName, new Date().toISOString());
  return token;
}

export function listDevices(database: Database.Database): ListedDevice[] {
  const rows = database
    .prepare(
      `SELECT id, name, created_at, last_seen_at, revoked_at
       FROM devices ORDER BY created_at ASC`,
    )
    .all() as Array<{
    id: string;
    name: string;
    created_at: string;
    last_seen_at: string | null;
    revoked_at: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  }));
}

export function revokeDevice(database: Database.Database, id: string): boolean {
  const result = database
    .prepare("UPDATE devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?")
    .run(new Date().toISOString(), id);
  return result.changes === 1;
}
