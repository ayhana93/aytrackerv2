/**
 * The offline point queue.
 *
 * Points are written to IndexedDB before they are sent, and removed only once the server has
 * acknowledged them. A driver who loses signal in a valley, or whose app is killed by the OS,
 * comes back with the route intact.
 *
 * Two deliberate limits:
 *
 *   * **A cap on stored points.** An unbounded queue on a phone that has been offline all day
 *     will eventually fill the origin's storage quota and start throwing on write — losing the
 *     newest points, which are the ones that matter most. When the cap is hit the *oldest*
 *     points go instead, and the drop is recorded so the resulting gap is visible rather than
 *     silent.
 *
 *   * **Nothing else is stored here.** No worker roster, no other drivers, no trip history. A
 *     lost phone should not be a data breach, and location is the most sensitive thing this
 *     product holds.
 */

import type { RawPoint } from './types';

const DB_NAME = 'aytracker-tracking';
/**
 * Version 2: the partition key became `sessionId`.
 *
 * It was `tripId`, back when a point could only belong to a trip. A phone that has run the old
 * build still has the v1 store with a `tripId` index on disk — and without a version bump
 * `onupgradeneeded` never fires, so `clear()` would throw `NotFoundError` looking for an index
 * that is not there. On a driver's phone that means a queue nobody can drain.
 */
const DB_VERSION = 2;
const STORE = 'points';

/** Roughly eight hours at the default sampling floor, with headroom. */
export const MAX_QUEUED_POINTS = 5000;

export interface QueuedPoint extends RawPoint {
  readonly sessionId: string;
  /** Monotonic within a session; the queue's ordering key. */
  readonly seq: number;
}

export interface PointQueue {
  enqueue(points: readonly QueuedPoint[]): Promise<{ dropped: number }>;
  /** Oldest first, so a replay preserves the order the driver actually drove. */
  peek(limit: number): Promise<readonly QueuedPoint[]>;
  remove(seqs: readonly number[]): Promise<void>;
  size(): Promise<number>;
  clear(sessionId: string): Promise<void>;
}

export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

export class IndexedDbPointQueue implements PointQueue {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          const store = db.objectStoreNames.contains(STORE)
            ? request.transaction!.objectStore(STORE)
            : db.createObjectStore(STORE, { keyPath: 'seq' });

          /*
           * Points queued under the old key are dropped, not migrated.
           *
           * They belong to trips that ended before this build existed, and re-keying them would
           * mean guessing which session they should have been under. An empty queue on the
           * upgrade is honest; a queue full of points nobody can attribute is not.
           */
          if (store.indexNames.contains('tripId')) {
            store.deleteIndex('tripId');
            store.clear();
          }
          if (!store.indexNames.contains('sessionId')) {
            store.createIndex('sessionId', 'sessionId', { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return this.dbPromise;
  }

  async enqueue(points: readonly QueuedPoint[]): Promise<{ dropped: number }> {
    if (points.length === 0) return { dropped: 0 };
    const db = await this.open();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const point of points) store.put(point);

      let dropped = 0;
      const countRequest = store.count();
      countRequest.onsuccess = () => {
        const overflow = countRequest.result - MAX_QUEUED_POINTS;
        if (overflow <= 0) return;
        // Drop the oldest. Losing the start of a long offline stretch is better than losing the
        // end, and either way the missing span shows up as a tracking gap.
        dropped = overflow;
        const cursorRequest = store.openCursor();
        let removed = 0;
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor || removed >= overflow) return;
          cursor.delete();
          removed += 1;
          cursor.continue();
        };
      };

      tx.oncomplete = () => resolve({ dropped });
      tx.onerror = () => reject(tx.error);
    });
  }

  async peek(limit: number): Promise<readonly QueuedPoint[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).getAll(null, limit);
      request.onsuccess = () => resolve(request.result as QueuedPoint[]);
      request.onerror = () => reject(request.error);
    });
  }

  async remove(seqs: readonly number[]): Promise<void> {
    if (seqs.length === 0) return;
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const seq of seqs) store.delete(seq);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async size(): Promise<number> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async clear(sessionId: string): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const index = tx.objectStore(STORE).index('sessionId');
      const request = index.openCursor(IDBKeyRange.only(sessionId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

/**
 * In-memory fallback for private browsing, where IndexedDB may be unavailable or throw.
 *
 * Losing the queue on reload is bad, but refusing to track at all is worse — and the driver is
 * told which mode they are in.
 */
export class MemoryPointQueue implements PointQueue {
  private points: QueuedPoint[] = [];

  async enqueue(points: readonly QueuedPoint[]): Promise<{ dropped: number }> {
    this.points.push(...points);
    const overflow = this.points.length - MAX_QUEUED_POINTS;
    if (overflow > 0) {
      this.points.splice(0, overflow);
      return { dropped: overflow };
    }
    return { dropped: 0 };
  }

  async peek(limit: number): Promise<readonly QueuedPoint[]> {
    return this.points.slice(0, limit);
  }

  async remove(seqs: readonly number[]): Promise<void> {
    const removing = new Set(seqs);
    this.points = this.points.filter((point) => !removing.has(point.seq));
  }

  async size(): Promise<number> {
    return this.points.length;
  }

  async clear(sessionId: string): Promise<void> {
    this.points = this.points.filter((point) => point.sessionId !== sessionId);
  }
}

export function createPointQueue(): PointQueue {
  return isIndexedDbAvailable() ? new IndexedDbPointQueue() : new MemoryPointQueue();
}
