import type { EntityPayload, EntityType, SyncOperation, SyncRequest } from "../shared/protocol.js";

const MAX_OPERATIONS = 500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;

export function validateSyncRequest(value: unknown): SyncRequest {
  if (!isObject(value) || !hasExactKeys(value, ["operations", "lastSyncVersion"])) {
    throw new ValidationError("body must contain only operations and lastSyncVersion");
  }
  if (!Array.isArray(value.operations)) {
    throw new ValidationError("operations must be an array");
  }
  if (value.operations.length > MAX_OPERATIONS) {
    throw new ValidationError(`operations must contain at most ${MAX_OPERATIONS} entries`);
  }
  if (!Number.isSafeInteger(value.lastSyncVersion) || (value.lastSyncVersion as number) < 0) {
    throw new ValidationError("lastSyncVersion must be a non-negative safe integer");
  }

  const operations = value.operations.map((operation, index) => validateOperation(operation, index));
  return { operations, lastSyncVersion: value.lastSyncVersion as number };
}

function validateOperation(value: unknown, index: number): SyncOperation {
  const location = `operations[${index}]`;
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "operationId",
      "entityType",
      "entityId",
      "operation",
      "payload",
      "createdAt",
    ])
  ) {
    throw new ValidationError(`${location} has an invalid shape`);
  }
  if (!isUuid(value.operationId)) {
    throw new ValidationError(`${location}.operationId must be a UUID`);
  }
  if (value.entityType !== "shopping_item" && value.entityType !== "travel_item") {
    throw new ValidationError(`${location}.entityType is invalid`);
  }
  if (!isUuid(value.entityId)) {
    throw new ValidationError(`${location}.entityId must be a UUID`);
  }
  if (value.operation !== "upsert") {
    throw new ValidationError(`${location}.operation must be upsert`);
  }
  if (!isIsoDate(value.createdAt)) {
    throw new ValidationError(`${location}.createdAt must be an ISO UTC timestamp`);
  }

  const entityType = value.entityType as EntityType;
  const payload = validatePayload(value.payload, entityType, `${location}.payload`);
  if (payload.id !== value.entityId) {
    throw new ValidationError(`${location}.payload.id must equal entityId`);
  }

  return {
    operationId: value.operationId,
    entityType,
    entityId: value.entityId,
    operation: "upsert",
    payload,
    createdAt: value.createdAt,
  };
}

function validatePayload(value: unknown, entityType: EntityType, location: string): EntityPayload {
  const keys =
    entityType === "shopping_item"
      ? ["id", "text", "completed", "position", "createdAt", "updatedAt", "deletedAt"]
      : ["id", "text", "visited", "createdAt", "updatedAt", "deletedAt"];
  if (!isObject(value) || !hasExactKeys(value, keys)) {
    throw new ValidationError(`${location} has an invalid shape for ${entityType}`);
  }
  if (!isUuid(value.id)) throw new ValidationError(`${location}.id must be a UUID`);
  if (typeof value.text !== "string" || value.text.trim().length === 0 || value.text.length > 240) {
    throw new ValidationError(`${location}.text must contain 1 to 240 characters`);
  }
  if (!isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt)) {
    throw new ValidationError(`${location} timestamps must be ISO UTC timestamps`);
  }
  if (value.deletedAt !== null && !isIsoDate(value.deletedAt)) {
    throw new ValidationError(`${location}.deletedAt must be null or an ISO UTC timestamp`);
  }

  if (entityType === "shopping_item") {
    if (typeof value.completed !== "boolean") {
      throw new ValidationError(`${location}.completed must be a boolean`);
    }
    if (typeof value.position !== "number" || !Number.isFinite(value.position)) {
      throw new ValidationError(`${location}.position must be a finite number`);
    }
    return value as unknown as EntityPayload;
  }

  if (typeof value.visited !== "boolean") {
    throw new ValidationError(`${location}.visited must be a boolean`);
  }
  return value as unknown as EntityPayload;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match?.[1]) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  const normalized = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  return new Date(parsed).toISOString() === normalized;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
