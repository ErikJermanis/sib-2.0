import type { SyncRequest, SyncResponse } from "../shared/protocol";
import {
  applySyncResponse,
  getSyncState,
  readSyncEnvelope,
  updateSyncState,
  type SyncState,
} from "./db";

export type SyncPhase = "idle" | "syncing" | "offline" | "unpaired";

export interface SyncStatus {
  phase: SyncPhase;
  prominent: boolean;
  lastSuccessAt: number | null;
}

export interface SyncEngineOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  isOnline?: () => boolean;
  onStatus?: (status: SyncStatus) => void;
}

export const STALE_ACTIVE_MS = 5 * 60 * 60 * 1000;
export const FAILURE_GRACE_MS = 30_000;
export const SYNC_INTERVAL_MS = 30_000;
export const SYNC_TIMEOUT_MS = 28_000;
export const MAX_SYNC_OPERATIONS = 500;

export class SyncEngine {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly isOnline: () => boolean;
  private readonly onStatus: (status: SyncStatus) => void;
  private running = false;
  private inFlight: Promise<void> | undefined;
  private rerunRequested = false;
  private stopped = false;
  private prominent = false;
  private unpaired = false;
  private failureTimer: number | undefined;
  private status: SyncStatus = { phase: "idle", prominent: false, lastSuccessAt: null };

  constructor(options: SyncEngineOptions = {}) {
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? SYNC_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.isOnline = options.isOnline ?? (() => navigator.onLine);
    this.onStatus = options.onStatus ?? (() => undefined);
  }

  getStatus(): SyncStatus {
    return { ...this.status };
  }

  async markActive(): Promise<void> {
    const state = await getSyncState();
    const lastActiveAt = state.lastActiveAt;
    this.prominent = lastActiveAt === null || this.now() - lastActiveAt >= STALE_ACTIVE_MS;
    this.status.lastSuccessAt = state.lastSuccessAt;
    await updateSyncState({ lastActiveAt: this.now() });
    if (this.prominent && !this.unpaired) this.emit("syncing");
    await this.requestSync();
  }

  async touchActive(): Promise<void> {
    await updateSyncState({ lastActiveAt: this.now() });
  }

  requestSync(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.rerunRequested = true;
      return this.inFlight ?? Promise.resolve();
    }
    this.inFlight = this.runLoop();
    return this.inFlight;
  }

  stop(): void {
    this.stopped = true;
    if (this.failureTimer !== undefined) window.clearTimeout(this.failureTimer);
  }

  private emit(phase: SyncPhase): void {
    this.status = { phase, prominent: this.prominent, lastSuccessAt: this.status.lastSuccessAt };
    this.onStatus({ ...this.status });
  }

  private async runLoop(): Promise<void> {
    this.running = true;
    try {
      do {
        this.rerunRequested = false;
        await this.runOnce();
      } while (this.rerunRequested && !this.stopped);
    } finally {
      this.running = false;
      this.inFlight = undefined;
    }
  }

  private async runOnce(): Promise<void> {
    if (!this.isOnline()) {
      await this.recordFailure();
      return;
    }

    if (this.prominent && !this.unpaired) this.emit("syncing");
    const envelope = await readSyncEnvelope();
    const operations = envelope.operations.slice(0, MAX_SYNC_OPERATIONS);
    const request: SyncRequest = { operations, lastSyncVersion: envelope.lastSyncVersion };
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), this.timeoutMs);

    let body: SyncResponse;
    try {
      const response = await this.fetcher("/api/sync", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (response.status === 401) {
        this.unpaired = true;
        if (this.failureTimer !== undefined) window.clearTimeout(this.failureTimer);
        this.failureTimer = undefined;
        this.emit("unpaired");
        return;
      }
      if (!response.ok) throw new Error(`Sinkronizacija nije uspjela (${response.status}).`);
      body = (await response.json()) as SyncResponse;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        await this.recordFailure();
        return;
      }
      await this.recordFailure();
      return;
    } finally {
      window.clearTimeout(timeout);
    }

    const sentIds = new Set(operations.map((operation) => operation.operationId));
    await applySyncResponse(body, sentIds);
    if (envelope.operations.length > operations.length) this.rerunRequested = true;
    this.unpaired = false;
    if (this.failureTimer !== undefined) window.clearTimeout(this.failureTimer);
    this.failureTimer = undefined;
    this.status.lastSuccessAt = this.now();
    this.prominent = false;
    this.emit("idle");
  }

  private async recordFailure(): Promise<void> {
    const state: SyncState = await getSyncState();
    const failureSince = state.failureSince ?? this.now();
    if (state.failureSince === null) await updateSyncState({ failureSince });
    if (this.unpaired) return;

    const showAt = failureSince + FAILURE_GRACE_MS;
    if (this.prominent || this.now() >= showAt) {
      this.emit("offline");
      return;
    }

    if (this.failureTimer !== undefined) window.clearTimeout(this.failureTimer);
    this.failureTimer = window.setTimeout(() => this.emit("offline"), Math.max(0, showAt - this.now()));
  }
}

export function createSyncEngine(options?: SyncEngineOptions): SyncEngine {
  return new SyncEngine(options);
}
