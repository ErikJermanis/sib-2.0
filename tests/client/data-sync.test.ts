// @vitest-environment jsdom

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DB_NAME,
  applySyncResponse,
  closeDb,
  commitLocalChanges,
  getOutboxOperations,
  getShoppingItems,
  getSyncState,
  makeShoppingItem,
  makeTravelItem,
  updateSyncState,
} from "../../src/client/db";
import { RETRY_DELAYS_MS, SyncEngine } from "../../src/client/sync";
import type { ShoppingItem, SyncRequest, SyncResponse } from "../../src/shared/protocol";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function shoppingItem(overrides: Partial<ShoppingItem> = {}): ShoppingItem {
  return {
    id: "shopping-1",
    text: "Milk",
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-01T10:00:00.000Z",
    deletedAt: null,
    completed: false,
    position: 0,
    ...overrides,
  };
}

function httpResponse(body: SyncResponse, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function deleteTestDatabase(): Promise<void> {
  await closeDb();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Failed to delete test database"));
    request.onblocked = () => reject(new Error("Test database deletion was blocked by an open connection"));
  });
}

describe.sequential("local-first client data and sync", () => {
  beforeEach(async () => {
    await deleteTestDatabase();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await deleteTestDatabase();
  });

  it("creates shopping and travel items with distinct client UUIDs", () => {
    const now = "2026-02-03T04:05:06.000Z";
    const shopping = makeShoppingItem("Bread", 3, now);
    const travel = makeTravelItem("Lisbon", now);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    expect(shopping).toMatchObject({
      text: "Bread",
      position: 3,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      completed: false,
    });
    expect(travel).toMatchObject({
      text: "Lisbon",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      visited: false,
    });
    expect(shopping.id).toMatch(uuid);
    expect(travel.id).toMatch(uuid);
    expect(shopping.id).not.toBe(travel.id);
  });

  it("commits an entity and its outbox operation together", async () => {
    const item = shoppingItem();

    await commitLocalChanges("shopping_item", [item]);

    expect(await getShoppingItems()).toEqual([item]);
    const operations = await getOutboxOperations();
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      entityType: "shopping_item",
      entityId: item.id,
      operation: "upsert",
      payload: item,
    });
    expect(operations[0].operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("rolls back all entity and outbox writes when a batch cannot commit", async () => {
    const valid = shoppingItem();
    const missingKey = { ...shoppingItem({ id: "shopping-2" }), id: undefined } as unknown as ShoppingItem;

    await expect(commitLocalChanges("shopping_item", [valid, missingKey])).rejects.toBeDefined();

    expect(await getShoppingItems()).toEqual([]);
    expect(await getOutboxOperations()).toEqual([]);
  });

  it("represents soft deletion as an upsert while retaining the local entity", async () => {
    const deletedAt = "2026-01-02T10:00:00.000Z";
    const deleted = shoppingItem({ updatedAt: deletedAt, deletedAt });

    await commitLocalChanges("shopping_item", [deleted]);

    expect(await getShoppingItems()).toEqual([deleted]);
    expect(await getOutboxOperations()).toEqual([
      expect.objectContaining({
        entityId: deleted.id,
        operation: "upsert",
        payload: deleted,
      }),
    ]);
  });

  it("acknowledges only sent operations and leaves unsent outbox work intact", async () => {
    await commitLocalChanges("shopping_item", [shoppingItem({ id: "sent" })]);
    await commitLocalChanges("shopping_item", [shoppingItem({ id: "unsent" })]);
    const operations = await getOutboxOperations();
    const sent = operations.find((operation) => operation.entityId === "sent")!;
    const unsent = operations.find((operation) => operation.entityId === "unsent")!;

    await applySyncResponse(
      {
        acceptedOperationIds: [sent.operationId, unsent.operationId],
        changes: [],
        currentSyncVersion: 1,
      },
      new Set([sent.operationId]),
    );

    expect(await getOutboxOperations()).toEqual([unsent]);
  });

  it("applies remote changes in version order and advances the sync cursor", async () => {
    await updateSyncState({ lastSyncVersion: 4 });
    const older = shoppingItem({ text: "Older remote value", updatedAt: "2026-01-02T00:00:00.000Z" });
    const newer = shoppingItem({ text: "Newest remote value", updatedAt: "2026-01-03T00:00:00.000Z" });

    await applySyncResponse({
      acceptedOperationIds: [],
      changes: [
        {
          version: 10,
          operationId: "remote-10",
          entityType: "shopping_item",
          entityId: newer.id,
          operation: "upsert",
          payload: newer,
        },
        {
          version: 8,
          operationId: "remote-8",
          entityType: "shopping_item",
          entityId: older.id,
          operation: "upsert",
          payload: older,
        },
      ],
      currentSyncVersion: 12,
    });

    expect(await getShoppingItems()).toEqual([newer]);
    expect(await getSyncState()).toMatchObject({
      lastSyncVersion: 12,
    });
  });

  it("preserves a newer local mutation created while sync is in flight", async () => {
    const entityId = "in-flight-item";
    const oldLocal = shoppingItem({ id: entityId, text: "Old local" });
    await commitLocalChanges("shopping_item", [oldLocal]);
    const response = deferred<Response>();
    const fetchMock = vi.fn<Fetcher>(() => response.promise);
    const engine = new SyncEngine({ fetcher: fetchMock as typeof fetch, isOnline: () => true });

    const sync = engine.requestSync();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as SyncRequest;
    const newerLocal = shoppingItem({
      id: entityId,
      text: "Newer local",
      updatedAt: "2026-01-04T00:00:00.000Z",
    });
    await commitLocalChanges("shopping_item", [newerLocal]);
    const remote = shoppingItem({ id: entityId, text: "Remote response" });

    response.resolve(
      httpResponse({
        acceptedOperationIds: [request.operations[0].operationId],
        changes: [
          {
            version: 5,
            operationId: "remote-5",
            entityType: "shopping_item",
            entityId,
            operation: "upsert",
            payload: remote,
          },
        ],
        currentSyncVersion: 5,
      }),
    );
    await sync;
    engine.stop();

    expect(await getShoppingItems()).toEqual([newerLocal]);
    const remaining = await getOutboxOperations();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].payload).toEqual(newerLocal);
    expect((await getSyncState()).lastSyncVersion).toBe(5);
  });

  it("sends the local envelope and records a successful sync", async () => {
    await commitLocalChanges("shopping_item", [shoppingItem()]);
    await updateSyncState({ lastSyncVersion: 7 });
    const operation = (await getOutboxOperations())[0];
    const fetchMock = vi.fn<Fetcher>(async () =>
      httpResponse({ acceptedOperationIds: [operation.operationId], changes: [], currentSyncVersion: 8 }),
    );
    const statuses: ReturnType<SyncEngine["getStatus"]>[] = [];
    const engine = new SyncEngine({
      fetcher: fetchMock as typeof fetch,
      isOnline: () => true,
      now: () => 12_345,
      onStatus: (status) => statuses.push(status),
    });

    await engine.requestSync();
    engine.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/sync");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({ operations: [operation], lastSyncVersion: 7 });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(await getOutboxOperations()).toEqual([]);
    expect(await getSyncState()).toMatchObject({ lastSyncVersion: 8 });
    expect(statuses.at(-1)).toEqual({ phase: "idle", prominent: false, lastSuccessAt: 12_345 });
  });

  it("coalesces concurrent sync requests into one in-flight request and one rerun", async () => {
    const firstResponse = deferred<Response>();
    const fetchMock = vi
      .fn<Fetcher>()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(async () =>
        httpResponse({ acceptedOperationIds: [], changes: [], currentSyncVersion: 2 }),
      );
    const engine = new SyncEngine({ fetcher: fetchMock as typeof fetch, isOnline: () => true });

    const first = engine.requestSync();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = engine.requestSync();
    expect(second).toBe(first);
    firstResponse.resolve(httpResponse({ acceptedOperationIds: [], changes: [], currentSyncVersion: 1 }));

    await Promise.all([first, second]);
    engine.stop();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await getSyncState()).lastSyncVersion).toBe(2);
  });

  it("enters the unpaired state on a 401 response", async () => {
    const fetchMock = vi.fn<Fetcher>(async () =>
      httpResponse({ acceptedOperationIds: [], changes: [], currentSyncVersion: 0 }, 401),
    );
    const engine = new SyncEngine({ fetcher: fetchMock as typeof fetch, isOnline: () => true });

    await engine.requestSync();
    engine.stop();

    expect(engine.getStatus()).toEqual({ phase: "unpaired", prominent: false, lastSuccessAt: null });
  });

  it("shows an immediate prominent offline state on lifecycle activation", async () => {
    const statuses: ReturnType<SyncEngine["getStatus"]>[] = [];
    const engine = new SyncEngine({
      isOnline: () => false,
      now: () => 50_000,
      onStatus: (status) => statuses.push(status),
    });

    await engine.markActive();
    engine.stop();

    expect(statuses).toEqual([
      { phase: "syncing", prominent: true, lastSuccessAt: null },
      { phase: "offline", prominent: true, lastSuccessAt: null },
    ]);
  });

  it("retries failed syncs after 10, 30, and 60 seconds then stops", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let attempts = 0;
    const engine = new SyncEngine({
      isOnline: () => {
        attempts += 1;
        return false;
      },
      isVisible: () => true,
    });

    await engine.markActive();
    expect(attempts).toBe(1);
    expect(engine.getStatus().phase).toBe("offline");
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1]);
    expect(attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[2]);
    expect(attempts).toBe(4);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempts).toBe(4);
    engine.stop();
  });

  it("resets a pending retry when a local mutation requests sync", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let attempts = 0;
    const engine = new SyncEngine({
      isOnline: () => {
        attempts += 1;
        return false;
      },
      isVisible: () => true,
    });

    await engine.requestSync();
    await vi.advanceTimersByTimeAsync(5_000);
    await engine.requestSync();
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] - 1);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(3);
    engine.stop();
  });

  it("does not poll after success and never retries after a 401", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const successfulFetch = vi.fn<Fetcher>(async () =>
      httpResponse({ acceptedOperationIds: [], changes: [], currentSyncVersion: 0 }),
    );
    const successfulEngine = new SyncEngine({
      fetcher: successfulFetch as typeof fetch,
      isOnline: () => true,
      isVisible: () => true,
    });

    await successfulEngine.markActive();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(successfulFetch).toHaveBeenCalledTimes(1);
    successfulEngine.stop();

    const rejectedFetch = vi.fn<Fetcher>(async () =>
      httpResponse({ acceptedOperationIds: [], changes: [], currentSyncVersion: 0 }, 401),
    );
    const rejectedEngine = new SyncEngine({
      fetcher: rejectedFetch as typeof fetch,
      isOnline: () => true,
      isVisible: () => true,
    });

    await rejectedEngine.requestSync();
    await rejectedEngine.markActive();
    await rejectedEngine.requestSync();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(rejectedFetch).toHaveBeenCalledTimes(1);
    rejectedEngine.stop();
  });

  it("removes acknowledged and remote tombstones from IndexedDB", async () => {
    const deleted = shoppingItem({ deletedAt: "2026-01-02T10:00:00.000Z" });
    await commitLocalChanges("shopping_item", [deleted]);
    const operation = (await getOutboxOperations())[0]!;

    await applySyncResponse(
      {
        acceptedOperationIds: [operation.operationId],
        changes: [
          {
            version: 1,
            operationId: operation.operationId,
            entityType: "shopping_item",
            entityId: deleted.id,
            operation: "upsert",
            payload: deleted,
          },
        ],
        currentSyncVersion: 1,
      },
      new Set([operation.operationId]),
      1,
    );

    expect(await getShoppingItems()).toEqual([]);
    expect(await getOutboxOperations()).toEqual([]);
  });

  it("reconciles cursor-zero responses as active-item snapshots", async () => {
    const retained = shoppingItem({ id: "retained" });
    const stale = shoppingItem({ id: "stale" });
    await commitLocalChanges("shopping_item", [retained, stale]);
    const operations = await getOutboxOperations();

    await applySyncResponse(
      {
        acceptedOperationIds: operations.map((operation) => operation.operationId),
        changes: [
          {
            version: 2,
            operationId: "remote-2",
            entityType: "shopping_item",
            entityId: retained.id,
            operation: "upsert",
            payload: retained,
          },
        ],
        currentSyncVersion: 2,
      },
      new Set(operations.map((operation) => operation.operationId)),
      0,
    );

    expect(await getShoppingItems()).toEqual([retained]);
  });
});
