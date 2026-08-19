import type { OrganizationId } from '@aytracker/types';

/**
 * Domain events are how modules talk to each other without importing each other.
 *
 * `reporting` learns that a shift closed by subscribing to `shift.completed`; it never calls
 * into `shifts`, and `shifts` has never heard of `reporting`. See docs/modular-architecture.md.
 */
export interface DomainEvent<TName extends string = string, TPayload = unknown> {
  readonly name: TName;
  readonly organizationId: OrganizationId;
  readonly occurredAt: Date;
  /** Correlates the event with the request that produced it. */
  readonly requestId?: string;
  readonly payload: TPayload;
}

export type EventHandler<TEvent extends DomainEvent = DomainEvent> = (
  event: TEvent,
) => void | Promise<void>;

export interface EventBus {
  publish(event: DomainEvent): Promise<void>;
  publishAll(events: readonly DomainEvent[]): Promise<void>;
  subscribe(eventName: string, handler: EventHandler): () => void;
}

/**
 * In-process event bus.
 *
 * Handlers run after the producing transaction commits — the publisher collects events and the
 * application service flushes them once the transaction returns. A handler that throws is
 * logged and does not fail the producing command; a subscriber that must not lose work should
 * write to an outbox instead of relying on this bus.
 */
export class InProcessEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly onHandlerError: (error: unknown, event: DomainEvent) => void;

  constructor(onHandlerError?: (error: unknown, event: DomainEvent) => void) {
    this.onHandlerError =
      onHandlerError ??
      ((error, event) => {
        console.error(`Event handler failed for ${event.name}`, error);
      });
  }

  subscribe(eventName: string, handler: EventHandler): () => void {
    const existing = this.handlers.get(eventName) ?? new Set<EventHandler>();
    existing.add(handler);
    this.handlers.set(eventName, existing);
    return () => {
      existing.delete(handler);
    };
  }

  async publish(event: DomainEvent): Promise<void> {
    const handlers = this.handlers.get(event.name);
    if (!handlers || handlers.size === 0) return;
    await Promise.all(
      [...handlers].map(async (handler) => {
        try {
          await handler(event);
        } catch (error) {
          this.onHandlerError(error, event);
        }
      }),
    );
  }

  async publishAll(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      await this.publish(event);
    }
  }
}

/**
 * Collects events raised inside a transaction so they can be published after it commits.
 * Publishing mid-transaction would let a subscriber observe state that later rolls back.
 */
export class EventCollector {
  private readonly collected: DomainEvent[] = [];

  add(event: DomainEvent): void {
    this.collected.push(event);
  }

  drain(): DomainEvent[] {
    return this.collected.splice(0, this.collected.length);
  }
}
