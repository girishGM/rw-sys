/**
 * T-014 — the `system_messages` catalogue, in memory (implementation note 7).
 *
 * > *"`MessageService` loads `system_messages` at boot with a periodic refresh; a missing key
 * > falls back to the key itself rather than throwing."*
 *
 * ### Why every failure mode here is a fallback and never an exception
 *
 * This service sits underneath `ErrorNormalizationFilter`. Anything it throws would be thrown
 * *while the application is already handling an error* — turning a clean 404 into an unhandled
 * 500, and doing it precisely when the system is least healthy (the database being unreachable
 * is both the reason the catalogue is stale and the reason a request failed). So:
 *
 *  - the initial load fails → log at `error`, serve keys, retry on the next tick;
 *  - a refresh fails → log at `error`, **keep the previous catalogue** rather than emptying it;
 *  - a key is absent → return the key.
 *
 * Returning the key is not a cosmetic fallback. 01-DATABASE.md §5.4 and T004_004 are explicit
 * that the API returns the **code** and the SPA renders the localised text client-side, so a
 * response carrying `"message": "NOT_FOUND"` is degraded, not broken — the client still knows
 * exactly what happened. What must never happen is an internal sentence reaching a client, and
 * a key can never be one.
 *
 * ### On the refresh timer
 *
 * Super Admin edits `system_messages` through the portal; a process that only read the table at
 * boot would serve stale wording until the next deploy. The timer is `unref()`ed so it can
 * never hold the process open — an unref'd interval is the difference between `npm test`
 * finishing and `npm test` hanging for five minutes, and between a container exiting on SIGTERM
 * and being killed.
 */
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Inject,
} from '@nestjs/common';
import { MESSAGE_STORE, type MessageStore } from './message.repository';

/**
 * How often the catalogue is re-read.
 *
 * Five minutes: message text is administrative copy, not a security control, so the cost of
 * being five minutes stale is a user seeing the previous wording once. Not an env var, because
 * `env.schema.ts` belongs to T-001 and nothing about this number is deployment-specific.
 */
export const MESSAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class MessageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessageService.name);
  private catalogue: ReadonlyMap<string, string> = new Map();
  private timer: NodeJS.Timeout | null = null;
  /** Keys already reported missing, so an unseeded code logs once rather than once per request. */
  private readonly reportedMissing = new Set<string>();

  constructor(@Inject(MESSAGE_STORE) private readonly store: MessageStore) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, MESSAGE_REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * The localised text for `key`, or `key` itself.
   *
   * Synchronous by design: the filter that calls it is on the error path of every request and
   * must not await a database round trip to render a 403.
   */
  get(key: string): string {
    const text = this.catalogue.get(key);
    if (text !== undefined) return text;

    // Logged once per key, at `warn` rather than `error`: a code with no row is a gap in the
    // seed catalogue that someone should close (see the T-014 completion report's list), not an
    // outage. Silence here is how such a gap survives to production.
    if (!this.reportedMissing.has(key)) {
      this.reportedMissing.add(key);
      this.logger.warn(`No system_messages row for '${key}' — falling back to the key itself.`);
    }
    return key;
  }

  /**
   * The whole catalogue, for `GET /me/bootstrap` (T-015), which ships it to the SPA in one call.
   *
   * A copy, not the live map: a consumer that could mutate the catalogue could change what every
   * subsequent error response says.
   */
  getAll(): Record<string, string> {
    return Object.fromEntries(this.catalogue);
  }

  /** Number of entries currently cached. Exists for the health/observability surface (T-052). */
  get size(): number {
    return this.catalogue.size;
  }

  /**
   * Re-reads the catalogue. Never throws, never empties a good cache on a failed read.
   *
   * The swap is atomic — a whole new `Map` replaces the old one in a single assignment — so a
   * concurrent `get()` sees either the complete old catalogue or the complete new one, never a
   * half-populated map.
   */
  async refresh(): Promise<void> {
    try {
      const rows = await this.store.loadAll();
      const next = new Map<string, string>();
      for (const row of rows) next.set(row.key, row.text);
      this.catalogue = next;
      // A key that was missing may now exist; let it be reported again if it disappears.
      this.reportedMissing.clear();
    } catch (error) {
      this.logger.error(
        `Failed to load system_messages — serving ${this.catalogue.size} cached message(s) ` +
          `and falling back to keys: ${(error as Error).message}`,
      );
    }
  }
}
