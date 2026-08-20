import type { TrackingState } from '@aytracker/tracking';

export interface RawPoint {
  readonly timestamp: number;
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyMeters: number | null;
  readonly speedMps: number | null;
  readonly heading: number | null;
  readonly altitude: number | null;
  readonly source: 'GPS' | 'NETWORK' | 'FUSED' | 'MANUAL';
}

/**
 * What the driver sees about their own tracking.
 *
 * Every field here exists to answer a question a driver would reasonably ask: is it recording,
 * how long since the last fix, how much is waiting to be sent, and — the one that matters most —
 * will it keep recording if I put the phone in my pocket.
 */
export interface CollectorStatus {
  readonly state: TrackingState;
  readonly lastFixAt: Date | null;
  readonly lastAccuracyMeters: number | null;
  readonly queuedPoints: number;
  /** True while the screen is being held awake to keep collection alive. */
  readonly screenHeldAwake: boolean;
  readonly permission: 'granted' | 'denied' | 'prompt' | 'unknown';
  /** Points dropped because the queue hit its cap. Non-zero means a visible gap. */
  readonly droppedPoints: number;
}

export interface CollectorOptions {
  readonly tripId: string;
  readonly minIntervalSeconds: number;
  readonly minDistanceMeters: number;
  /** Uploads a batch. Resolves when the server has accepted it. */
  upload(points: readonly RawPoint[]): Promise<void>;
  onStatusChange?(status: CollectorStatus): void;
  /**
   * Whether to hold the screen awake.
   *
   * Off by default, and surfaced as a choice rather than assumed: keeping a phone's display lit
   * for a two-hour drive is a real battery cost, and the driver is the one who knows whether
   * their phone is on a charger in a cradle or in a jacket pocket.
   */
  readonly holdScreenAwake?: boolean;
}

export interface LocationCollector {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Sends whatever is queued. Called on reconnect and before the app goes away. */
  flush(): Promise<void>;
  status(): CollectorStatus;
}
