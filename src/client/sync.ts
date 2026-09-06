import type { SyncRequest, SyncResponse } from "../shared/protocol";
import {
  applySyncResponse,
  getSyncState,
  readSyncEnvelope,
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
  isVisible?: () => boolean;
  onStatus?: (status: SyncStatus) => void;
}

export const SYNC_TIMEOUT_MS = 28_000;
export const MAX_SYNC_OPERATIONS = 500;
export const RETRY_DELAYS_MS = [10_000, 30_000, 60_000] as const;

export class SyncEngine {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly isOnline: () => boolean;
  private readonly isVisible: () => boolean;
  private readonly onStatus: (status: SyncStatus) => void;
  private running = false;
  private inFlight: Promise<void> | undefined;
  private rerunRequested = false;
  private stopped = false;
  private prominent = false;
  private unpaired = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryIndex = 0;
  private status: SyncStatus = { phase: "idle", prominent: false, lastSuccessAt: null };

  constructor(options: SyncEngineOptions = {}) {
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? SYNC_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.isOnline = options.isOnline ?? (() => navigator.onLine);
    this.isVisible = options.isVisible ?? (() => document.visibilityState === "visible");
    this.onStatus = options.onStatus ?? (() => undefined);
  }

  getStatus(): SyncStatus {
    return { ...this.status };
  }

  async markActive(): Promise<void> {
    if (this.stopped || this.unpaired) return;
    const state = await getSyncState();
    if (this.stopped || this.unpaired) return;
    this.status.lastSuccessAt = state.lastSuccessAt;
    this.startSync(true, true);
    await this.inFlight;
  }

  requestSync(): Promise<void> {
    this.startSync(false, true);
    return this.inFlight ?? Promise.resolve();
  }

  markUnpaired(): void {
    if (this.stopped || this.unpaired) return;
    this.unpaired = true;
    this.rerunRequested = false;
    this.clearRetryTimer();
    this.emit("unpaired");
  }

  stop(): void {
    this.stopped = true;
    this.rerunRequested = false;
    this.clearRetryTimer();
  }

  private startSync(prominent: boolean, resetRetries: boolean): void {
    if (this.stopped || this.unpaired) return;
    if (resetRetries) {
      this.retryIndex = 0;
      this.clearRetryTimer();
    }
    this.prominent ||= prominent;
    if (this.prominent) this.emit("syncing");
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    this.inFlight = this.runLoop();
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
        const succeeded = await this.runOnce();
        if (this.stopped || this.unpaired) break;
        if (!succeeded) {
          if (!this.rerunRequested) {
            this.scheduleRetry();
            break;
          }
        }
      } while (this.rerunRequested && !this.stopped && !this.unpaired);
    } finally {
      this.running = false;
      this.inFlight = undefined;
    }
  }

  private async runOnce(): Promise<boolean> {
    if (!this.isOnline()) {
      this.recordFailure();
      return false;
    }

    if (this.prominent && !this.unpaired) this.emit("syncing");
    const envelope = await readSyncEnvelope();
    const operations = envelope.operations.slice(0, MAX_SYNC_OPERATIONS);
    const request: SyncRequest = { operations, lastSyncVersion: envelope.lastSyncVersion };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

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
        this.markUnpaired();
        return false;
      }
      if (!response.ok) throw new Error(`Sinkronizacija nije uspjela (${response.status}).`);
      body = (await response.json()) as SyncResponse;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        this.recordFailure();
        return false;
      }
      this.recordFailure();
      return false;
    } finally {
      clearTimeout(timeout);
    }

    const sentIds = new Set(operations.map((operation) => operation.operationId));
    await applySyncResponse(body, sentIds, envelope.lastSyncVersion);
    if (envelope.operations.length > operations.length) this.rerunRequested = true;
    this.unpaired = false;
    this.retryIndex = 0;
    this.clearRetryTimer();
    this.status.lastSuccessAt = this.now();
    this.prominent = false;
    this.emit("idle");
    return true;
  }

  private recordFailure(): void {
    if (!this.stopped && !this.unpaired) this.emit("offline");
  }

  private scheduleRetry(): void {
    if (this.stopped || this.unpaired || this.retryIndex >= RETRY_DELAYS_MS.length) return;
    const delay = RETRY_DELAYS_MS[this.retryIndex++];
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.stopped || this.unpaired || !this.isVisible()) return;
      this.startSync(false, false);
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === undefined) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}

export function createSyncEngine(options?: SyncEngineOptions): SyncEngine {
  return new SyncEngine(options);
}
