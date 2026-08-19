import type { DriverId, OrganizationId, UserId, WorkerId } from './ids.js';

export type ActorType = 'USER' | 'WORKER' | 'DRIVER';

/**
 * The authenticated caller, as reconstructed by the server from the session row.
 *
 * Nothing in here ever comes from the request body, a header, or a query parameter. That is
 * the whole point: `organizationId` on this object is the only tenant the request may touch.
 */
export interface ActorContext {
  readonly actorType: ActorType;
  readonly organizationId: OrganizationId;
  readonly userId?: UserId;
  readonly workerId?: WorkerId;
  readonly driverId?: DriverId;
  readonly permissions: readonly string[];
  readonly sessionId: string;
  /** Platform staff acting inside a tenant; recorded in every audit entry. */
  readonly isPlatformAdmin: boolean;
}

/** Request-scoped metadata carried alongside the actor for audit and observability. */
export interface RequestContext {
  readonly requestId: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly receivedAt: Date;
}

export interface OperationContext {
  readonly actor: ActorContext;
  readonly request: RequestContext;
}
