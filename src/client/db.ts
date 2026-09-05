import type {
  EntityPayload,
  EntityType,
  ServerChange,
  ShoppingItem,
  SyncOperation,
  SyncResponse,
  TravelItem,
} from "../shared/protocol";

export const DB_NAME = "sib-2.0";
export const DB_VERSION = 1;
export const STORE_NAMES = {
  shopping: "shopping_items",
  travel: "travel_items",
  outbox: "sync_outbox",
  state: "sync_state",
} as const;

export interface SyncState {
  key: "sync";
  lastSyncVersion: number;
  lastActiveAt: number | null;
  lastSuccessAt: number | null;
  failureSince: number | null;
}

export const DEFAULT_SYNC_STATE: SyncState = {
  key: "sync",
  lastSyncVersion: 0,
  lastActiveAt: null,
  lastSuccessAt: null,
  failureSince: null,
};

const changes = new EventTarget();
let databasePromise: Promise<IDBDatabase> | undefined;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB zahtjev nije uspio."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transakcija je prekinuta."));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transakcija nije uspjela."));
  });
}

function abortTransaction(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // The transaction has already completed or aborted.
  }
}

export function openDb(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const shopping = db.createObjectStore(STORE_NAMES.shopping, { keyPath: "id" });
      shopping.createIndex("position", "position");
      db.createObjectStore(STORE_NAMES.travel, { keyPath: "id" }).createIndex("createdAt", "createdAt");
      const outbox = db.createObjectStore(STORE_NAMES.outbox, { keyPath: "operationId" });
      outbox.createIndex("entity", ["entityType", "entityId"]);
      outbox.createIndex("createdAt", "createdAt");
      db.createObjectStore(STORE_NAMES.state, { keyPath: "key" });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        databasePromise = undefined;
      };
      resolve(db);
    };
    request.onerror = () => {
      databasePromise = undefined;
      reject(request.error ?? new Error("Bazu podataka nije moguće otvoriti."));
    };
    request.onblocked = () => {
      databasePromise = undefined;
      reject(new Error("Otvaranje baze blokirala je druga kartica."));
    };
  });

  return databasePromise;
}

export async function closeDb(): Promise<void> {
  const pendingDatabase = databasePromise;
  databasePromise = undefined;
  if (pendingDatabase) (await pendingDatabase).close();
}

export function subscribeToDb(listener: () => void): () => void {
  changes.addEventListener("change", listener);
  return () => changes.removeEventListener("change", listener);
}

function notifyDbChanged(): void {
  changes.dispatchEvent(new Event("change"));
}

export async function getShoppingItems(): Promise<ShoppingItem[]> {
  const db = await openDb();
  const transaction = db.transaction(STORE_NAMES.shopping, "readonly");
  const result = await requestResult(transaction.objectStore(STORE_NAMES.shopping).getAll() as IDBRequest<ShoppingItem[]>);
  await transactionDone(transaction);
  return result;
}

export async function getTravelItems(): Promise<TravelItem[]> {
  const db = await openDb();
  const transaction = db.transaction(STORE_NAMES.travel, "readonly");
  const result = await requestResult(transaction.objectStore(STORE_NAMES.travel).getAll() as IDBRequest<TravelItem[]>);
  await transactionDone(transaction);
  return result;
}

export async function getOutboxOperations(): Promise<SyncOperation[]> {
  const db = await openDb();
  const transaction = db.transaction(STORE_NAMES.outbox, "readonly");
  const result = await requestResult(
    transaction.objectStore(STORE_NAMES.outbox).index("createdAt").getAll() as IDBRequest<SyncOperation[]>,
  );
  await transactionDone(transaction);
  return result;
}

export async function getSyncState(): Promise<SyncState> {
  const db = await openDb();
  const transaction = db.transaction(STORE_NAMES.state, "readonly");
  const result = await requestResult(
    transaction.objectStore(STORE_NAMES.state).get(DEFAULT_SYNC_STATE.key) as IDBRequest<SyncState | undefined>,
  );
  await transactionDone(transaction);
  return result ?? { ...DEFAULT_SYNC_STATE };
}

export async function updateSyncState(update: Partial<Omit<SyncState, "key">>): Promise<SyncState> {
  const db = await openDb();
  const transaction = db.transaction(STORE_NAMES.state, "readwrite");
  const store = transaction.objectStore(STORE_NAMES.state);
  const current = await requestResult(store.get(DEFAULT_SYNC_STATE.key) as IDBRequest<SyncState | undefined>);
  const next = { ...(current ?? DEFAULT_SYNC_STATE), ...update };
  store.put(next);
  await transactionDone(transaction);
  return next;
}

function storeForEntity(entityType: EntityType): typeof STORE_NAMES.shopping | typeof STORE_NAMES.travel {
  return entityType === "shopping_item" ? STORE_NAMES.shopping : STORE_NAMES.travel;
}

export async function commitLocalChanges(entityType: "shopping_item", items: ShoppingItem[]): Promise<void>;
export async function commitLocalChanges(entityType: "travel_item", items: TravelItem[]): Promise<void>;
export async function commitLocalChanges(entityType: EntityType, items: EntityPayload[]): Promise<void> {
  if (items.length === 0) return;
  const db = await openDb();
  const itemStoreName = storeForEntity(entityType);
  const transaction = db.transaction([itemStoreName, STORE_NAMES.outbox], "readwrite");
  const completion = transactionDone(transaction);
  const itemStore = transaction.objectStore(itemStoreName);
  const outbox = transaction.objectStore(STORE_NAMES.outbox);

  try {
    for (const item of items) {
      itemStore.put(item);
      const operation: SyncOperation = {
        operationId: crypto.randomUUID(),
        entityType,
        entityId: item.id,
        operation: "upsert",
        payload: item,
        createdAt: new Date().toISOString(),
      };
      outbox.put(operation);
    }
    await completion;
  } catch (error) {
    abortTransaction(transaction);
    await completion.catch(() => undefined);
    throw error;
  }
  notifyDbChanged();
}

export interface SyncEnvelope {
  operations: SyncOperation[];
  lastSyncVersion: number;
}

export async function readSyncEnvelope(): Promise<SyncEnvelope> {
  const db = await openDb();
  const transaction = db.transaction([STORE_NAMES.outbox, STORE_NAMES.state], "readonly");
  const operationsRequest = transaction.objectStore(STORE_NAMES.outbox).index("createdAt").getAll() as IDBRequest<
    SyncOperation[]
  >;
  const stateRequest = transaction.objectStore(STORE_NAMES.state).get(DEFAULT_SYNC_STATE.key) as IDBRequest<
    SyncState | undefined
  >;
  const [operations, state] = await Promise.all([requestResult(operationsRequest), requestResult(stateRequest)]);
  await transactionDone(transaction);
  return { operations, lastSyncVersion: state?.lastSyncVersion ?? 0 };
}

function entityKey(entityType: EntityType, entityId: string): IDBValidKey {
  return [entityType, entityId];
}

export async function applySyncResponse(response: SyncResponse, sentOperationIds?: ReadonlySet<string>): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction(
    [STORE_NAMES.shopping, STORE_NAMES.travel, STORE_NAMES.outbox, STORE_NAMES.state],
    "readwrite",
  );
  const completion = transactionDone(transaction);
  const outbox = transaction.objectStore(STORE_NAMES.outbox);
  const entityIndex = outbox.index("entity");

  try {
    for (const operationId of response.acceptedOperationIds) {
      if (!sentOperationIds || sentOperationIds.has(operationId)) outbox.delete(operationId);
    }

    const orderedChanges = [...response.changes].sort((left, right) => left.version - right.version);
    for (const change of orderedChanges) {
      const pendingCount = await requestResult(entityIndex.count(entityKey(change.entityType, change.entityId)));
      if (pendingCount === 0) transaction.objectStore(storeForEntity(change.entityType)).put(change.payload);
    }

    const stateStore = transaction.objectStore(STORE_NAMES.state);
    const current = await requestResult(stateStore.get(DEFAULT_SYNC_STATE.key) as IDBRequest<SyncState | undefined>);
    stateStore.put({
      ...(current ?? DEFAULT_SYNC_STATE),
      lastSyncVersion: Math.max(current?.lastSyncVersion ?? 0, response.currentSyncVersion),
      lastSuccessAt: Date.now(),
      failureSince: null,
    } satisfies SyncState);
    await completion;
  } catch (error) {
    abortTransaction(transaction);
    await completion.catch(() => undefined);
    throw error;
  }
  notifyDbChanged();
}

export function makeShoppingItem(text: string, position: number, now = new Date().toISOString()): ShoppingItem {
  return {
    id: crypto.randomUUID(),
    text,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    completed: false,
    position,
  };
}

export function makeTravelItem(text: string, now = new Date().toISOString()): TravelItem {
  return {
    id: crypto.randomUUID(),
    text,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    visited: false,
  };
}

export type { ServerChange };
