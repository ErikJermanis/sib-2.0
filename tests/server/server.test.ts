import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPairingToken,
  listDevices,
  openDatabase,
  revokeDevice,
} from "../../src/server/database.js";
import { hashToken } from "../../src/server/security.js";
import { buildServer } from "../../src/server/server.js";
import { validateSyncRequest } from "../../src/server/validation.js";
import type {
  ShoppingItem,
  SyncOperation,
  TravelItem,
} from "../../src/shared/protocol.js";

const DEVICE_A_ID = "10000000-0000-4000-8000-000000000001";
const DEVICE_B_ID = "10000000-0000-4000-8000-000000000002";
const PAIRING_ID = "10000000-0000-4000-8000-000000000003";
const SHOPPING_ID = "20000000-0000-4000-8000-000000000001";
const TRAVEL_ID = "20000000-0000-4000-8000-000000000002";
const OPERATION_1_ID = "30000000-0000-4000-8000-000000000001";
const OPERATION_2_ID = "30000000-0000-4000-8000-000000000002";
const OPERATION_3_ID = "30000000-0000-4000-8000-000000000003";
const DEVICE_A_TOKEN = "device-a-session-token";
const DEVICE_B_TOKEN = "device-b-session-token";
const CREATED_AT = "2026-01-02T03:04:05.000Z";
const DEVICE_B_CREATED_AT = "2026-01-02T03:04:06.000Z";
const UPDATED_AT = "2026-01-03T04:05:06.000Z";
const LATER_UPDATED_AT = "2026-01-04T05:06:07.000Z";
const DELETED_AT = "2026-01-05T06:07:08.000Z";

function shoppingOperation(
  operationId = OPERATION_1_ID,
  payloadOverrides: Partial<ShoppingItem> = {},
): SyncOperation {
  const payload: ShoppingItem = {
    id: SHOPPING_ID,
    text: "Milk",
    completed: false,
    position: 10.5,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    deletedAt: null,
    ...payloadOverrides,
  };
  return {
    operationId,
    entityType: "shopping_item",
    entityId: payload.id,
    operation: "upsert",
    payload,
    createdAt: UPDATED_AT,
  };
}

function travelOperation(operationId = OPERATION_2_ID): SyncOperation {
  const payload: TravelItem = {
    id: TRAVEL_ID,
    text: "Lisbon",
    visited: false,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    deletedAt: null,
  };
  return {
    operationId,
    entityType: "travel_item",
    entityId: TRAVEL_ID,
    operation: "upsert",
    payload,
    createdAt: UPDATED_AT,
  };
}

function syncBody(operations: SyncOperation[] = [shoppingOperation()], lastSyncVersion = 0) {
  return { operations, lastSyncVersion };
}

function uncheckedSyncBody(operations: unknown[], lastSyncVersion = 0) {
  return { operations, lastSyncVersion };
}

function seedDevice(
  database: Database.Database,
  id: string,
  name: string,
  sessionToken: string,
  createdAt = CREATED_AT,
): void {
  database
    .prepare(
      `INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL, NULL)`,
    )
    .run(id, name, hashToken(sessionToken), createdAt);
}

function cookie(sessionToken: string): string {
  return `sib_session=${sessionToken}`;
}

describe("validateSyncRequest", () => {
  it.each([
    [null, "body must contain only operations and lastSyncVersion"],
    [{ operations: [] }, "body must contain only operations and lastSyncVersion"],
    [
      { operations: [], lastSyncVersion: 0, unexpected: true },
      "body must contain only operations and lastSyncVersion",
    ],
    [{ operations: {}, lastSyncVersion: 0 }, "operations must be an array"],
    [{ operations: [], lastSyncVersion: -1 }, "lastSyncVersion must be a non-negative safe integer"],
    [{ operations: [], lastSyncVersion: 1.5 }, "lastSyncVersion must be a non-negative safe integer"],
    [
      { operations: [], lastSyncVersion: Number.MAX_SAFE_INTEGER + 1 },
      "lastSyncVersion must be a non-negative safe integer",
    ],
  ])("rejects an invalid top-level body %#", (body, message) => {
    expect(() => validateSyncRequest(body)).toThrow(message);
  });

  it("enforces the operation count limit", () => {
    expect(() =>
      validateSyncRequest({
        operations: Array.from({ length: 501 }, () => shoppingOperation()),
        lastSyncVersion: 0,
      }),
    ).toThrow("operations must contain at most 500 entries");
  });

  it("requires exact operation and payload shapes", () => {
    const operationWithExtraKey = { ...shoppingOperation(), unexpected: true };
    expect(() => validateSyncRequest(syncBody([operationWithExtraKey]))).toThrow(
      "operations[0] has an invalid shape",
    );

    const operation = shoppingOperation();
    const payloadWithExtraKey = { ...operation.payload, unexpected: true };
    expect(() =>
      validateSyncRequest(syncBody([{ ...operation, payload: payloadWithExtraKey }])),
    ).toThrow("operations[0].payload has an invalid shape for shopping_item");
  });

  it("strictly validates operation identifiers, kinds, timestamps, and entity identity", () => {
    expect(() =>
      validateSyncRequest(syncBody([{ ...shoppingOperation(), operationId: "not-a-uuid" }])),
    ).toThrow("operations[0].operationId must be a UUID");
    expect(() =>
      validateSyncRequest(uncheckedSyncBody([{ ...shoppingOperation(), entityType: "note" }])),
    ).toThrow("operations[0].entityType is invalid");
    expect(() =>
      validateSyncRequest(syncBody([{ ...shoppingOperation(), entityId: "not-a-uuid" }])),
    ).toThrow("operations[0].entityId must be a UUID");
    expect(() =>
      validateSyncRequest(uncheckedSyncBody([{ ...shoppingOperation(), operation: "delete" }])),
    ).toThrow("operations[0].operation must be upsert");
    expect(() =>
      validateSyncRequest(syncBody([{ ...shoppingOperation(), createdAt: "2026-01-03" }])),
    ).toThrow("operations[0].createdAt must be an ISO UTC timestamp");

    const operation = shoppingOperation();
    expect(() =>
      validateSyncRequest(
        uncheckedSyncBody([
          {
            ...operation,
            entityId: TRAVEL_ID,
          },
        ]),
      ),
    ).toThrow("operations[0].payload.id must equal entityId");
  });

  it("rejects impossible calendar timestamps instead of allowing Date.parse normalization", () => {
    expect(() =>
      validateSyncRequest(
        uncheckedSyncBody([
          {
            ...shoppingOperation(),
            createdAt: "2026-02-30T03:04:05.000Z",
          },
        ]),
      ),
    ).toThrow("operations[0].createdAt must be an ISO UTC timestamp");
  });

  it("strictly validates shopping and travel payload fields", () => {
    const shopping = shoppingOperation();
    expect(() =>
      validateSyncRequest(
        uncheckedSyncBody([
          {
            ...shopping,
            payload: { ...shopping.payload, text: "   " },
          },
        ]),
      ),
    ).toThrow("operations[0].payload.text must contain 1 to 240 characters");
    expect(() =>
      validateSyncRequest(
        uncheckedSyncBody([
          {
            ...shopping,
            payload: { ...shopping.payload, text: "x".repeat(241) },
          },
        ]),
      ),
    ).toThrow("operations[0].payload.text must contain 1 to 240 characters");
    expect(() =>
      validateSyncRequest(
        uncheckedSyncBody([
          {
            ...shopping,
            payload: { ...shopping.payload, completed: 1 },
          },
        ]),
      ),
    ).toThrow("operations[0].payload.completed must be a boolean");
    expect(() =>
      validateSyncRequest(
        uncheckedSyncBody([
          {
            ...shopping,
            payload: { ...shopping.payload, position: Number.POSITIVE_INFINITY },
          },
        ]),
      ),
    ).toThrow("operations[0].payload.position must be a finite number");

    const travel = travelOperation();
    expect(() =>
      validateSyncRequest(
        uncheckedSyncBody([
          {
            ...travel,
            payload: { ...travel.payload, visited: "no" },
          },
        ]),
      ),
    ).toThrow("operations[0].payload.visited must be a boolean");
  });
});

describe("SiB server", () => {
  let database: Database.Database;
  let app: FastifyInstance;

  beforeEach(() => {
    database = openDatabase(":memory:");
    seedDevice(database, DEVICE_A_ID, "Erik iPhone", DEVICE_A_TOKEN);
    seedDevice(database, DEVICE_B_ID, "Galaxy S24", DEVICE_B_TOKEN, DEVICE_B_CREATED_AT);
    app = buildServer({
      database,
      env: {},
      config: {
        host: "127.0.0.1",
        port: 3000,
        databasePath: ":memory:",
        publicBaseUrl: "http://127.0.0.1:3000",
        nodeEnv: "test",
      },
    });
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  it("consumes a pairing link once and authenticates the resulting session cookie", async () => {
    const rawPairingToken = "one-time-pairing-token";
    database
      .prepare(
        `INSERT INTO pairing_tokens (id, token_hash, device_name, created_at, used_at)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(PAIRING_ID, hashToken(rawPairingToken), "Kitchen iPad", CREATED_AT);

    const pairing = await app.inject({ method: "GET", url: `/pair/${rawPairingToken}` });

    expect(pairing.statusCode).toBe(302);
    expect(pairing.headers.location).toBe("/shopping");
    const setCookie = Array.isArray(pairing.headers["set-cookie"])
      ? pairing.headers["set-cookie"][0]
      : pairing.headers["set-cookie"];
    expect(setCookie).toMatch(
      /^sib_session=[A-Za-z0-9_-]+; Max-Age=315360000; Path=\/; HttpOnly; SameSite=Lax$/,
    );
    const sessionCookie = setCookie?.split(";", 1)[0];
    expect(sessionCookie).toBeTruthy();

    const session = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: sessionCookie! },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ authenticated: true, deviceName: "Kitchen iPad" });

    const reused = await app.inject({ method: "GET", url: `/pair/${rawPairingToken}` });
    expect(reused.statusCode).toBe(410);
    expect(reused.headers["set-cookie"]).toBeUndefined();
    expect(reused.body).toContain("Poveznica više nije valjana");
    expect(database.prepare("SELECT COUNT(*) AS count FROM devices").get()).toEqual({ count: 3 });
    expect(
      database.prepare("SELECT used_at FROM pairing_tokens WHERE id = ?").get(PAIRING_ID),
    ).toMatchObject({ used_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
  });

  it("rejects session and sync requests without authentication", async () => {
    const [session, sync] = await Promise.all([
      app.inject({ method: "GET", url: "/api/session" }),
      app.inject({ method: "POST", url: "/api/sync", payload: syncBody([], 0) }),
    ]);

    expect(session.statusCode).toBe(401);
    expect(session.json()).toEqual({ authenticated: false });
    expect(sync.statusCode).toBe(401);
    expect(sync.json()).toEqual({ error: "Authentication required" });
  });

  it("stores accepted operations and returns cursor-based pulls", async () => {
    const operation = shoppingOperation();
    const push = await app.inject({
      method: "POST",
      url: "/api/sync",
      headers: { cookie: cookie(DEVICE_A_TOKEN) },
      payload: syncBody([operation], 0),
    });

    expect(push.statusCode).toBe(200);
    expect(push.json()).toEqual({
      acceptedOperationIds: [OPERATION_1_ID],
      changes: [
        {
          version: 1,
          operationId: OPERATION_1_ID,
          entityType: "shopping_item",
          entityId: SHOPPING_ID,
          operation: "upsert",
          payload: operation.payload,
        },
      ],
      currentSyncVersion: 1,
    });
    expect(database.prepare("SELECT * FROM shopping_items WHERE id = ?").get(SHOPPING_ID)).toEqual({
      id: SHOPPING_ID,
      text: "Milk",
      completed: 0,
      position: 10.5,
      created_at: CREATED_AT,
      updated_at: UPDATED_AT,
      deleted_at: null,
      server_version: 1,
    });

    const pull = await app.inject({
      method: "POST",
      url: "/api/sync",
      headers: { cookie: cookie(DEVICE_A_TOKEN) },
      payload: syncBody([], 0),
    });
    expect(pull.json()).toMatchObject({
      acceptedOperationIds: [],
      changes: [{ version: 1, operationId: OPERATION_1_ID, payload: operation.payload }],
      currentSyncVersion: 1,
    });

    const caughtUp = await app.inject({
      method: "POST",
      url: "/api/sync",
      headers: { cookie: cookie(DEVICE_A_TOKEN) },
      payload: syncBody([], 1),
    });
    expect(caughtUp.json()).toEqual({
      acceptedOperationIds: [],
      changes: [],
      currentSyncVersion: 1,
    });
  });

  it("deduplicates operation retries without allocating another server version", async () => {
    const request = {
      method: "POST" as const,
      url: "/api/sync",
      headers: { cookie: cookie(DEVICE_A_TOKEN) },
      payload: syncBody([shoppingOperation(), shoppingOperation()], 0),
    };
    const first = await app.inject(request);
    const retry = await app.inject({
      ...request,
      payload: syncBody([shoppingOperation()], 1),
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      acceptedOperationIds: [OPERATION_1_ID],
      currentSyncVersion: 1,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({
      acceptedOperationIds: [OPERATION_1_ID],
      changes: [],
      currentSyncVersion: 1,
    });
    expect(database.prepare("SELECT COUNT(*) AS count, MAX(version) AS version FROM changes").get()).toEqual(
      { count: 1, version: 1 },
    );
    expect(database.prepare("SELECT COUNT(*) AS count FROM processed_operations").get()).toEqual({
      count: 1,
    });
  });

  it("lets another device pull changes written by the first device", async () => {
    await app.inject({
      method: "POST",
      url: "/api/sync",
      headers: { cookie: cookie(DEVICE_A_TOKEN) },
      payload: syncBody([travelOperation()], 0),
    });

    const pull = await app.inject({
      method: "POST",
      url: "/api/sync",
      headers: { cookie: cookie(DEVICE_B_TOKEN) },
      payload: syncBody([], 0),
    });

    expect(pull.statusCode).toBe(200);
    expect(pull.json()).toEqual({
      acceptedOperationIds: [],
      changes: [
        {
          version: 1,
          operationId: OPERATION_2_ID,
          entityType: "travel_item",
          entityId: TRAVEL_ID,
          operation: "upsert",
          payload: travelOperation().payload,
        },
      ],
      currentSyncVersion: 1,
    });
  });

  it("uses server receipt order for last-write-wins even when client timestamps run backwards", async () => {
    const timestampNewer = shoppingOperation(OPERATION_1_ID, {
      text: "Received first",
      updatedAt: LATER_UPDATED_AT,
    });
    const timestampOlder = shoppingOperation(OPERATION_2_ID, {
      text: "Received second",
      completed: true,
      updatedAt: CREATED_AT,
    });

    await app.inject({
      method: "POST",
      url: "/api/sync",
      headers: { cookie: cookie(DEVICE_A_TOKEN) },
      payload: syncBody([timestampNewer], 0),
    });
    await app.inject({
      method: "POST",
      url: "/api/sync",
      headers: { cookie: cookie(DEVICE_B_TOKEN) },
      payload: syncBody([timestampOlder], 1),
    });

    expect(
      database
        .prepare("SELECT text, completed, updated_at, server_version FROM shopping_items WHERE id = ?")
        .get(SHOPPING_ID),
    ).toEqual({
      text: "Received second",
      completed: 1,
      updated_at: CREATED_AT,
      server_version: 2,
    });
    const pull = await app.inject({
      method: "POST",
      url: "/api/sync",
      headers: { cookie: cookie(DEVICE_A_TOKEN) },
      payload: syncBody([], 0),
    });
    expect(pull.json().changes).toEqual([
      expect.objectContaining({ version: 1, payload: timestampNewer.payload }),
      expect.objectContaining({ version: 2, payload: timestampOlder.payload }),
    ]);
  });

  it("replicates a soft-delete payload without removing the entity row", async () => {
    await app.inject({
      method: "POST",
      url: "/api/sync",
      headers: { cookie: cookie(DEVICE_A_TOKEN) },
      payload: syncBody([shoppingOperation()], 0),
    });
    const deletion = shoppingOperation(OPERATION_2_ID, {
      text: "Milk",
      updatedAt: DELETED_AT,
      deletedAt: DELETED_AT,
    });
    await app.inject({
      method: "POST",
      url: "/api/sync",
      headers: { cookie: cookie(DEVICE_A_TOKEN) },
      payload: syncBody([deletion], 1),
    });

    const pull = await app.inject({
      method: "POST",
      url: "/api/sync",
      headers: { cookie: cookie(DEVICE_B_TOKEN) },
      payload: syncBody([], 1),
    });
    expect(pull.json()).toEqual({
      acceptedOperationIds: [],
      changes: [
        {
          version: 2,
          operationId: OPERATION_2_ID,
          entityType: "shopping_item",
          entityId: SHOPPING_ID,
          operation: "upsert",
          payload: deletion.payload,
        },
      ],
      currentSyncVersion: 2,
    });
    expect(
      database.prepare("SELECT deleted_at, server_version FROM shopping_items WHERE id = ?").get(SHOPPING_ID),
    ).toEqual({ deleted_at: DELETED_AT, server_version: 2 });
  });

  it("rejects a future cursor without changing server state", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/sync",
      headers: { cookie: cookie(DEVICE_A_TOKEN) },
      payload: syncBody([shoppingOperation()], 1),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "lastSyncVersion is ahead of the server" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM changes").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM shopping_items").get()).toEqual({ count: 0 });
  });

  it("atomically rejects a request containing one invalid operation", async () => {
    const invalid = { ...travelOperation(OPERATION_2_ID), unexpected: true };
    const response = await app.inject({
      method: "POST",
      url: "/api/sync",
      headers: { cookie: cookie(DEVICE_A_TOKEN) },
      payload: syncBody([shoppingOperation(), invalid]),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "operations[1] has an invalid shape" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM changes").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM processed_operations").get()).toEqual({
      count: 0,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM shopping_items").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM travel_items").get()).toEqual({ count: 0 });
  });

  it("invalidates an existing cookie immediately when its device is revoked", async () => {
    const before = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: cookie(DEVICE_A_TOKEN) },
    });
    expect(before.statusCode).toBe(200);

    expect(revokeDevice(database, DEVICE_A_ID)).toBe(true);

    const [session, sync] = await Promise.all([
      app.inject({
        method: "GET",
        url: "/api/session",
        headers: { cookie: cookie(DEVICE_A_TOKEN) },
      }),
      app.inject({
        method: "POST",
        url: "/api/sync",
        headers: { cookie: cookie(DEVICE_A_TOKEN) },
        payload: syncBody([], 0),
      }),
    ]);
    expect(session.statusCode).toBe(401);
    expect(session.json()).toEqual({ authenticated: false });
    expect(sync.statusCode).toBe(401);
    expect(sync.json()).toEqual({ error: "Authentication required" });
  });
});

describe("database administration helpers", () => {
  it("creates hashed one-time tokens and lists/revokes devices", () => {
    const database = openDatabase(":memory:");
    try {
      seedDevice(database, DEVICE_A_ID, "Erik iPhone", DEVICE_A_TOKEN);
      seedDevice(database, DEVICE_B_ID, "Galaxy S24", DEVICE_B_TOKEN, DEVICE_B_CREATED_AT);

      const pairingToken = createPairingToken(database, "Kitchen iPad");
      const pairing = database
        .prepare("SELECT token_hash, device_name, used_at FROM pairing_tokens")
        .get() as { token_hash: string; device_name: string; used_at: string | null };
      expect(pairing).toEqual({
        token_hash: hashToken(pairingToken),
        device_name: "Kitchen iPad",
        used_at: null,
      });
      expect(pairing.token_hash).not.toBe(pairingToken);

      expect(listDevices(database)).toEqual([
        {
          id: DEVICE_A_ID,
          name: "Erik iPhone",
          createdAt: CREATED_AT,
          lastSeenAt: null,
          revokedAt: null,
        },
        {
          id: DEVICE_B_ID,
          name: "Galaxy S24",
          createdAt: DEVICE_B_CREATED_AT,
          lastSeenAt: null,
          revokedAt: null,
        },
      ]);
      expect(revokeDevice(database, "10000000-0000-4000-8000-000000000099")).toBe(false);
      expect(revokeDevice(database, DEVICE_B_ID)).toBe(true);
      expect(listDevices(database)[1]).toMatchObject({
        id: DEVICE_B_ID,
        revokedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      });
    } finally {
      database.close();
    }
  });
});
