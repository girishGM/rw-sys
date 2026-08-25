/**
 * T-045 — the seam implementation note 2 names as one of the trace's four sources: *"gRPC
 * config-fetch access logs."*
 *
 * 09-INTEGRATION.md §"Audit" describes the source this would read from: *"Each RPC writes a
 * sampled access log with the service identity, tenant and campaign."* That access log has no
 * table yet — `grpc_service_grants` (09-INTEGRATION.md, the grant table) exists only as a design
 * section, and T-047 ("gRPC campaign configuration service"), the task that would create the
 * table and populate it, has not started and is not a dependency of this one.
 *
 * AGENT-PROTOCOL §7 names this exact situation: *"A required column or table does not exist in
 * `reward_config`: do not create it."* This file is the escalation made mechanical — a seam with
 * the shape T-047 will need, wired to a `null`-implementation today, rather than either inventing
 * the table here (out of scope and against R1's spirit for a schema this task does not own) or
 * leaving `configFetches` unhandled in `trace.service.ts` (which would make the trace endpoint's
 * behaviour for this source undocumented instead of explicitly "not configured yet").
 */
import { Injectable } from '@nestjs/common';

/** DI token — consumers depend on {@link ConfigFetchAdapter}, never on a concrete class. */
export const CONFIG_FETCH_ADAPTER = Symbol('CONFIG_FETCH_ADAPTER');

export interface ConfigFetchAdapter {
  /**
   * Every gRPC config-fetch access-log entry for `correlationId`, capped at `limit`.
   *
   * `null` — never a thrown error — when the source is not wired, exactly like
   * {@link import('./log-store.adapter').LogStoreAdapter.fetchLines}: `trace.service.ts` reads it
   * as `sources.configFetches` and degrades the response rather than failing the request.
   */
  fetchEntries(
    correlationId: string,
    limit: number,
  ): Promise<readonly Record<string, unknown>[] | null>;
}

/** The only binding today. T-047 replaces this with a real implementation over its own store. */
@Injectable()
export class NullConfigFetchAdapter implements ConfigFetchAdapter {
  async fetchEntries(_correlationId: string, _limit: number): Promise<null> {
    return Promise.resolve(null);
  }
}
