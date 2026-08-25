/**
 * T-045 — whether an adapter is wired at all, as distinct from whether it answered *this*
 * request.
 *
 * `LogStoreAdapter.fetchLines` and `ConfigFetchAdapter.fetchEntries` both return `null` for two
 * different reasons — "no adapter is configured" and "the configured adapter could not answer
 * right now" — and the wire contract (`packages/shared/src/trace.schema.ts`) reports them as two
 * different statuses (`not_configured` vs `unavailable`) so an operator reading the trace can
 * tell "nobody has wired this up yet" apart from "this is down, go check it". An adapter cannot
 * make that distinction about itself from inside `fetchLines` — `NullLogStoreAdapter` always
 * returns `null` and has no way to know whether it was chosen deliberately or is the fallback.
 * This config is decided once, at module wiring time from `TRACE_LOG_STORE`/environment, and
 * carried alongside the adapter rather than inferred from its class (`instanceof
 * NullLogStoreAdapter` would work but makes every adapter's identity part of the contract;
 * a boolean the module already knows is simpler and is exactly what a unit test can inject).
 */
export interface TraceSourceConfig {
  readonly logStoreConfigured: boolean;
  readonly configFetchConfigured: boolean;
}

/** DI token for {@link TraceSourceConfig}. */
export const TRACE_SOURCE_CONFIG = Symbol('TRACE_SOURCE_CONFIG');

/** Neither adapter configured — today's default until an operator sets `TRACE_LOG_STORE`, and
 * always true of `configFetchConfigured` until T-047 exists. */
export const DEFAULT_TRACE_SOURCE_CONFIG: TraceSourceConfig = Object.freeze({
  logStoreConfigured: false,
  configFetchConfigured: false,
});
