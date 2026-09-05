export type EntityType = "shopping_item" | "travel_item";

export interface BaseItem {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ShoppingItem extends BaseItem {
  completed: boolean;
  position: number;
}

export interface TravelItem extends BaseItem {
  visited: boolean;
}

export type EntityPayload = ShoppingItem | TravelItem;

export interface SyncOperation {
  operationId: string;
  entityType: EntityType;
  entityId: string;
  operation: "upsert";
  payload: EntityPayload;
  createdAt: string;
}

export interface ServerChange {
  version: number;
  operationId: string;
  entityType: EntityType;
  entityId: string;
  operation: "upsert";
  payload: EntityPayload;
}

export interface SyncRequest {
  operations: SyncOperation[];
  lastSyncVersion: number;
}

export interface SyncResponse {
  acceptedOperationIds: string[];
  changes: ServerChange[];
  currentSyncVersion: number;
}

export interface SessionResponse {
  authenticated: boolean;
  deviceName?: string;
}
