/**
 * T-017 — the policy cache (implementation note 8).
 *
 * > *"Policy cache invalidates on write; TTL from config; a cache failure **denies** (masks),
 * > never falls back to plain."*
 *
 * ---
 *
 * ### Why the read path is synchronous
 *
 * A pino/winston serialiser is called synchronously while a log line is being formatted, and a
 * response interceptor's `map` is synchronous too. Neither can `await` a database round trip —
 * so the cache holds a fully-built {@link PolicySet} in memory and {@link current} returns it
 * without I/O. Refreshing is the asynchronous half, and it happens on a boundary (boot, TTL
 * expiry noticed by a caller, explicit invalidation), never in the middle of formatting a line.
 *
 * ### The failure mode this class is designed around
 *
 * There is no snapshot at three moments: before the first successful load, after a load that
 * threw, and after a `PolicyValidationError` rejected the whole configuration. In all three,
 * {@link current} **throws** and every consumer falls back to `FAIL_CLOSED_POLICY` — omit from
 * logs, mask in responses. That is TC-21, and it is why `current()` is not written to return
 * `PolicySet | null`: a nullable return invites `?? somethingPermissive` at a call site, and one
 * such call site is a silent, permanent hole. Throwing forces every consumer to state its
 * fallback explicitly, and the two that matter — {@link resolveColumnSafe} and
 * {@link resolveFieldNameSafe} — state it here, once.
 *
 * ### TTL expiry does *not* discard the snapshot
 *
 * An expired snapshot is served while a refresh runs in the background, rather than being
 * dropped. Dropping it would mean a TTL boundary and a database blip together produce a request
 * whose every field is masked — a self-inflicted outage triggered by a clock, on a table that
 * changes perhaps twice a year. Stale-while-revalidate is bounded by the TTL and is the correct
 * trade here; genuine invalidation (a policy write) is explicit and immediate via
 * {@link invalidate}, which is what TC-20 exercises.
 */
import { Inject, Injectable, Logger, Optional, OnModuleInit } from '@nestjs/common';
import { DATA_PROTECTION_CONFIG, type DataProtectionConfig } from './data-protection.config';
import { POLICY_STORE, type PolicyStore } from './policy.repository';
import {
  FAIL_CLOSED_POLICY,
  PolicySet,
  type DataProtectionPolicy,
  type PolicyLookup,
  type ResolvedPolicy,
} from './policy.service';

/** Thrown by {@link PolicyCacheService.current} when no usable snapshot exists. */
export class PolicyCacheUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `The data-protection policy cache has no usable snapshot (${reason}). Callers must fail ` +
        `closed — mask or omit — rather than treating this as "no policy applies".`,
    );
    this.name = 'PolicyCacheUnavailableError';
    Error.captureStackTrace?.(this, PolicyCacheUnavailableError);
  }
}

@Injectable()
export class PolicyCacheService implements PolicyLookup, OnModuleInit {
  private readonly logger = new Logger(PolicyCacheService.name);

  private snapshot: PolicySet | null = null;
  private loadedAt = 0;
  private lastFailure: string | null = 'not loaded yet';
  private inFlight: Promise<void> | null = null;

  /**
   * `@Optional()` on the clock is load-bearing, not decoration — the same trap `RateLimitGuard`
   * documents. A constructor parameter with a default is still a parameter as far as
   * `design:paramtypes` is concerned, so without it Nest tries to resolve a provider for
   * `Function`, finds none, and refuses to build the module: *"Nest can't resolve dependencies of
   * the PolicyCacheService (…, ?)"*. It is a parameter at all so the TTL tests can advance time
   * without `jest.useFakeTimers()` leaking into a suite that also does real I/O.
   */
  constructor(
    @Inject(POLICY_STORE) private readonly store: PolicyStore,
    @Inject(DATA_PROTECTION_CONFIG) private readonly config: DataProtectionConfig,
    @Optional() private readonly now: () => number = Date.now,
  ) {}

  /**
   * Loads the policy table at boot.
   *
   * A failure here is logged at `error` and **does not** stop the application: the engine is
   * already fail-closed without a snapshot, so refusing to boot would convert a transient
   * database blip into an outage while making nothing safer. The alarm is the `error` line plus
   * every field in the process being masked, which is not a state anyone will fail to notice.
   */
  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  /** The current snapshot, or a throw. See the file header on why this is not nullable. */
  current(): PolicySet {
    if (this.snapshot === null) {
      throw new PolicyCacheUnavailableError(this.lastFailure ?? 'unknown');
    }
    if (this.isStale()) {
      // Fire-and-forget: the *stale* snapshot is still returned below. See the header.
      void this.refresh();
    }
    return this.snapshot;
  }

  /**
   * Re-reads the table and replaces the snapshot. Never rejects.
   *
   * On failure the **previous** snapshot is kept. A policy table that has become unreadable is
   * not a reason to stop applying the policy that was read successfully thirty seconds ago —
   * discarding it would mask every field in every response over a transient error, which is
   * fail-closed in the letter and self-harm in the spirit. The failure is recorded and logged;
   * if there was never a snapshot, the engine stays fail-closed, which is TC-21.
   */
  async refresh(): Promise<void> {
    // Collapses concurrent callers onto one query — otherwise every request arriving in the
    // window after a TTL expiry starts its own table scan.
    if (this.inFlight !== null) return this.inFlight;

    this.inFlight = this.load().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * Drops the TTL so the next {@link current} refreshes, and starts that refresh immediately.
   *
   * Called after any write to `data_protection_policies` (TC-20: *"policy changed to `plain`,
   * cache invalidated ⇒ response updates without a restart"*). The snapshot is deliberately
   * **not** cleared first: clearing it would mask every field for the duration of the reload,
   * turning a routine policy edit into a visible blip. Stale-for-one-query is the better trade,
   * and `await`ing this method gives a caller the strong guarantee when it needs one.
   */
  async invalidate(): Promise<void> {
    this.loadedAt = 0;
    await this.refresh();
  }

  // --- PolicyLookup, throwing form ---------------------------------------------------------

  resolveColumn(table: string, column: string): ResolvedPolicy {
    return this.current().resolveColumn(table, column);
  }

  resolveDtoField(dto: string, field: string): ResolvedPolicy {
    return this.current().resolveDtoField(dto, field);
  }

  resolveFieldName(name: string): ResolvedPolicy | null {
    return this.current().resolveFieldName(name);
  }

  policyFor(policyKey: string): DataProtectionPolicy | null {
    return this.current().policyFor(policyKey);
  }

  columnPoliciesFor(table: string): readonly DataProtectionPolicy[] {
    return this.current().columnPoliciesFor(table);
  }

  protectedTables(): readonly string[] {
    return this.current().protectedTables();
  }

  // --- PolicyLookup, fail-closed form -------------------------------------------------------

  /**
   * {@link resolveColumn}, answering {@link FAIL_CLOSED_POLICY} instead of throwing.
   *
   * This is the form the serialiser and the response interceptor use. Both run on a path where
   * throwing would be strictly worse than masking: a serialiser that throws turns a log call
   * into a 500 (`redact.ts` argues the same), and an interceptor that throws turns a policy-cache
   * blip into a failed request for the user. Masking is the answer to both.
   */
  resolveColumnSafe(table: string, column: string): ResolvedPolicy {
    return this.safely(() => this.resolveColumn(table, column));
  }

  /** {@link resolveDtoField}, fail-closed. */
  resolveDtoFieldSafe(dto: string, field: string): ResolvedPolicy {
    return this.safely(() => this.resolveDtoField(dto, field));
  }

  /**
   * {@link resolveFieldName}, fail-closed.
   *
   * Note the asymmetry with the two above: a *successful* lookup that matches nothing returns
   * `null` ("no policy governs this name", so the caller applies its own default), whereas a
   * *failed* lookup returns `FAIL_CLOSED_POLICY` ("the engine cannot answer", so mask). Collapsing
   * the two would make an unreachable cache indistinguishable from an unclassified field, and
   * that distinction is the entire content of TC-21.
   */
  resolveFieldNameSafe(name: string): ResolvedPolicy | null {
    return this.safely(() => this.resolveFieldName(name));
  }

  /** Whether a usable snapshot exists. For health checks (T-052) and for the boot log. */
  get isLoaded(): boolean {
    return this.snapshot !== null;
  }

  /** Enabled row count, or `-1` when unloaded. Diagnostics only. */
  get policyCount(): number {
    return this.snapshot?.size ?? -1;
  }

  // --- internals ----------------------------------------------------------------------------

  private safely<T extends ResolvedPolicy | null>(read: () => T): T | ResolvedPolicy {
    try {
      return read();
    } catch (error) {
      // `debug`, not `error`: on a cold or broken cache this would otherwise fire once per field
      // per log line and drown the very failure it reports. `refresh()` logs the cause once, at
      // `error`, which is where an operator should be looking.
      this.logger.debug(
        `Policy lookup failed closed: ${(error as Error).message}. Field masked/omitted.`,
      );
      return FAIL_CLOSED_POLICY;
    }
  }

  private isStale(): boolean {
    const ttlMs = this.config.cache.ttlSeconds * 1000;
    if (ttlMs === 0) return false;
    return this.now() - this.loadedAt >= ttlMs;
  }

  private async load(): Promise<void> {
    try {
      const rows = await this.store.findAllPolicies();
      // Building validates every row and throws on the first bad one — see `validatePolicy`.
      // That is intentional: a policy set is configuration, and half-loaded configuration is
      // worse than none, because the missing half is invisible.
      const set = new PolicySet(rows, this.config);
      this.snapshot = set;
      this.loadedAt = this.now();
      this.lastFailure = null;
      this.logger.log(`Data-protection policies loaded: ${String(set.size)} enabled row(s).`);
    } catch (error) {
      this.lastFailure = (error as Error).message;
      this.logger.error(
        `Failed to load reward_portal.data_protection_policies — ${this.lastFailure}. ` +
          (this.snapshot === null
            ? 'No snapshot is available, so every protected field will be masked or omitted ' +
              '(fail-closed). Fix the policy table; the engine will not open up on its own.'
            : 'The previous snapshot remains in force.'),
      );
    }
  }
}
