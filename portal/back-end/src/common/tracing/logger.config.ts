/**
 * T-019 — the structured log schema of 08-OBSERVABILITY.md §3, as a winston format pipeline.
 *
 * > *"Every line is one JSON object with a fixed envelope. Fixed keys are what make logs
 * > queryable rather than greppable."*
 *
 * ```jsonc
 * { "ts": "…", "level": "info", "msg": "request completed",
 *   "correlationId": "…", "requestId": "…", "traceId": "…", "spanId": "…",
 *   "actor":  { "userId": 42, "role": "maker", "sessionId": "…" },
 *   "scope":  { "countryId": 3, "tenantId": 7, "merchantId": null },
 *   "http":   { "method": "POST", "route": "/api/v1/campaigns/:id/submit", … },
 *   "db":     { "queryCount": 7, "totalMs": 38 },
 *   "outcome":{ "result": "success" },
 *   "service":{ "name": "portal-api", "version": "1.4.2", "env": "production", … } }
 * ```
 *
 * ---
 *
 * ## The three properties this pipeline has to hold, and where each is enforced
 *
 * **1. `actor` and `scope` on _every_ line** (§3: *"'Which tenant was this?' is the second
 * question asked in every investigation, and joining to find it is friction that stops people
 * investigating"*). {@link traceEnvelopeFormat} adds them to every record, including lines logged
 * by code that knows nothing about tracing, and including unauthenticated requests — where the
 * keys are present with `null` values rather than absent (TC-10). A missing key and a null key
 * are different things to a log query: the first makes `actor.userId IS NULL` return nothing.
 *
 * **2. Everything passes through the T-017 masking serialiser** (§3: *"Everything in this object
 * passes through the masking serialiser … before it is written. Tracing and data protection are
 * not in tension"*). {@link maskingFormat} is the last format before `json()`, so it sees the
 * envelope, the caller's metadata and the message string alike. This is implementation note 6 of
 * the task file — *"Tracing must not become the leak path"* — and it is the reason this file
 * exists at all rather than a bare `winston.format.json()`.
 *
 * **3. The logger works before the policy cache does.** The masking serialiser needs
 * `PolicyCacheService`, which needs the database, which cannot be up before the process that logs
 * its own boot. So the policy lookup is **late-bound** through {@link logPolicyBinding}: until it
 * is bound, every line goes through T-014's pattern-based `redact()` instead, which needs nothing.
 * Binding can only ever make masking *stricter*, never weaker.
 *
 * ### Why late binding rather than an ordinary DI dependency
 *
 * This is worth stating precisely, because "just inject `PolicyCacheService` into `LoggerModule`"
 * is the obvious alternative and it is actively wrong here. Nest registers modules depth-first
 * from `AppModule.imports`, and it collects `APP_INTERCEPTOR` providers in **module-registration
 * order**. `PolicyCacheService` lives in `DataProtectionModule`, which also registers
 * `ResponseMaskingInterceptor`. Importing that module from `LoggerModule` — which must be near
 * the front of `AppModule.imports` so the logger exists early — would pull `DataProtectionModule`
 * forward with it, ahead of `TransportCryptoModule`. Interceptors' response-side logic runs in
 * *reverse* registration order, so that inverts 07-DATA-PROTECTION.md §8's fixed
 * `DTO → mask → serialise → encrypt` into `encrypt → mask`: the envelope would be built from the
 * unmasked body, and **nothing would visibly fail** (see the note in `app.module.ts`, and T-018's
 * TC-17). A logging convenience is not worth that, so the dependency is resolved lazily instead.
 */
import { format, transports, type Logform, type LoggerOptions, type transport } from 'winston';
import { redactForLog } from '@/common/logging/redact';
import { maskForLog, type SweepHit } from '@/common/data-protection/log-masking.serializer';
import type { PolicyLookup } from '@/common/data-protection/policy.service';
import { TraceContext, ANONYMOUS_ACTOR, UNSCOPED } from './trace-context';

/** The `service.name` of §3's envelope. One process, one name — never derived from a hostname. */
export const SERVICE_NAME = 'portal-api';

/** Levels this application emits, in 08-OBSERVABILITY.md §4's order of severity. */
export type PortalLogLevel = 'error' | 'warn' | 'info' | 'debug';

/** §3's `service` block. Fixed for the process's lifetime. */
export interface ServiceIdentity {
  readonly name: string;
  readonly version: string;
  readonly env: string;
  readonly instance: string;
}

export interface LoggerBuildOptions {
  readonly service: ServiceIdentity;
  /** Lines below this level are dropped before any format runs. */
  readonly level: PortalLogLevel;
  /**
   * Overrides the console transport. Tests pass a memory transport; nothing in `src` does.
   * Present so the pipeline can be asserted on real emitted lines rather than on a mock of
   * winston — the schema is the deliverable, and a mock would let it drift.
   */
  readonly transports?: transport[];
}

/**
 * The late-bound policy lookup for {@link maskingFormat}.
 *
 * Deliberately a tiny mutable holder rather than a bare `let`: `bind(null)` gives a test (and a
 * shutdown path) a way back to the T-014 floor, and the two-method surface makes every mutation
 * of it greppable. See the header for why this is not an injected dependency.
 */
class LogPolicyBinding {
  private lookup: PolicyLookup | null = null;

  /** Installs the T-017 policy engine into the log pipeline. Idempotent. */
  bind(lookup: PolicyLookup | null): void {
    this.lookup = lookup;
  }

  /** The bound lookup, or `null` when only T-014's pattern redaction is in force. */
  current(): PolicyLookup | null {
    return this.lookup;
  }
}

export const logPolicyBinding = new LogPolicyBinding();

/**
 * The complete winston configuration.
 *
 * Format order is load-bearing and reads bottom-up in effect: the envelope is assembled first so
 * that masking sees it, and `json()` runs last so that masking sees objects rather than a string.
 */
export function buildLoggerOptions(options: LoggerBuildOptions): LoggerOptions {
  return {
    level: options.level,
    format: format.combine(
      timestampFormat(),
      traceEnvelopeFormat(),
      serviceFormat(options.service),
      messageKeyFormat(),
      maskingFormat(),
      format.json(),
    ),
    transports: options.transports ?? [new transports.Console()],
    // A logger that exits the process on a transport error is a logger that turns a full disk
    // into an outage. Winston's default is to emit `error` on the logger, which is unhandled
    // and therefore fatal; this is the one place that trade is decided.
    exitOnError: false,
  };
}

/**
 * `LOG_LEVEL` if it names one of the four levels, else a per-environment default.
 *
 * `debug` in development and `info` everywhere else, because §4 puts *"guard decisions, cache
 * hit/miss, SQL statements"* at `debug` and marks the last of those "(non-production only)". An
 * unrecognised value falls back rather than throwing: a typo in an operator's environment
 * variable must not stop the process booting, and it is visible immediately in the first line the
 * logger writes.
 */
export function resolveLogLevel(configured: string | undefined, nodeEnv: string): PortalLogLevel {
  if (isPortalLogLevel(configured)) return configured;
  return nodeEnv === 'development' ? 'debug' : 'info';
}

/** Whether a string is one of the four levels §4 defines. */
export function isPortalLogLevel(value: string | undefined): value is PortalLogLevel {
  return value === 'error' || value === 'warn' || value === 'info' || value === 'debug';
}

// --- the formats -------------------------------------------------------------------------------

/**
 * §3's `ts`, in ISO-8601 with milliseconds.
 *
 * Hand-rolled rather than `format.timestamp({ alias: 'ts' })`, which adds `ts` **and** keeps
 * `timestamp` — two keys carrying the same instant, one of which is not in the schema. A fixed-key
 * envelope with a stray synonym in it invites half the queries to be written against the wrong
 * one.
 */
export function timestampFormat(): Logform.Format {
  return format((info) => ({ ...info, ts: new Date().toISOString() }))();
}

/**
 * Adds the identifiers, `actor` and `scope` from the ambient trace.
 *
 * Outside a request — a boot line, a CLI, a scheduled job — the identifier keys are `null` and
 * `actor`/`scope` are the shared anonymous objects. The keys are always present, for the reason
 * property 1 in the header gives.
 *
 * A caller that already set one of these keys wins: a line that says "this is about correlation
 * id X" while running in the context of Y is deliberate (T-045's trace assembler does exactly
 * that), and silently overwriting it would make that line a lie.
 */
export function traceEnvelopeFormat(): Logform.Format {
  return format((info) => {
    const trace = TraceContext.current();
    const snapshot = trace?.snapshot();

    return {
      ...info,
      correlationId: info.correlationId ?? trace?.correlationId ?? null,
      requestId: info.requestId ?? trace?.requestId ?? null,
      traceId: info.traceId ?? trace?.traceId ?? null,
      spanId: info.spanId ?? trace?.spanId ?? null,
      actor: info.actor ?? snapshot?.actor ?? ANONYMOUS_ACTOR,
      scope: info.scope ?? snapshot?.scope ?? UNSCOPED,
    };
  })();
}

/** Adds §3's `service` block to every line. */
export function serviceFormat(service: ServiceIdentity): Logform.Format {
  return format((info) => ({ ...info, service }))();
}

/**
 * Renames winston's `message` to §3's `msg`.
 *
 * The schema in §3 says `msg`, and a fixed-key schema that is nearly right is worse than one that
 * is obviously wrong — every query written against the document would silently return nothing.
 * The rename happens *before* masking so that the sweep still sees the text (a message string
 * that quotes a token is exactly what T-017's final regex sweep exists to catch).
 *
 * Mutating the record rather than returning `{ ...rest, msg }` is not a micro-optimisation:
 * `TransformableInfo` declares `message` as a **required** property, so an object literal without
 * it is not assignable and the obvious spread does not compile. Deleting through the index
 * signature expresses the same thing and keeps winston's symbols on the record (see
 * {@link maskingFormat}).
 */
export function messageKeyFormat(): Logform.Format {
  return format((info) => {
    const record = info as Record<string, unknown>;
    record.msg = normaliseMessage(info.message);
    delete record.message;
    return info;
  })();
}

/**
 * The T-017 masking serialiser, or T-014's `redact()` until the policy engine is bound.
 *
 * ### Why the record is rewritten in place instead of returned fresh
 *
 * Winston carries `level` and the rendered line on the record under `Symbol.for('level')` and
 * `Symbol.for('message')`, and every transport reads them from there. Both masking functions
 * build a **new plain object** from `Object.keys`, which does not carry symbols — returning that
 * object would produce records that no transport can level-filter or write. So the masked result
 * is copied back onto the original record, whose symbols are untouched. Keys that masking removed
 * (a `log_treatment` of `omit`) are deleted rather than left behind, or omission would silently
 * become a no-op.
 */
export function maskingFormat(): Logform.Format {
  return format((info) => {
    const masked = maskRecord(plainKeysOf(info));

    for (const key of Object.keys(info)) delete (info as Record<string, unknown>)[key];
    return Object.assign(info, masked);
  })();
}

// --- internals ---------------------------------------------------------------------------------

/** Own enumerable **string** keys only — winston's symbols are handled by {@link maskingFormat}. */
function plainKeysOf(info: Logform.TransformableInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(info)) out[key] = (info as Record<string, unknown>)[key];
  return out;
}

/** Policy masking when bound, pattern redaction otherwise. Never throws — see T-017's guarantees. */
function maskRecord(record: Record<string, unknown>): Record<string, unknown> {
  const policies = logPolicyBinding.current();
  if (policies === null) return redactForLog(record);

  return maskForLog(record, {
    policies,
    // Always on. The sweep is the layer that catches a credential arriving under an innocuous
    // key name, which is precisely the case a tracing layer creates by logging whole objects.
    finalRegexSweep: true,
    onSweepHit: reportSweepHit,
  }) as Record<string, unknown>;
}

/**
 * The sweep alarm, written straight to stderr as its own JSON line.
 *
 * It cannot go through this logger: the alarm is raised *from inside* the serialiser, so logging
 * it would re-enter the format that raised it (T-017's `LogMaskingOptions.onSweepHit` documents
 * the same hazard and asks the logger's owner — this task — to route it elsewhere). `stderr`
 * keeps it structured and queryable, which `console.warn`'s prose would not.
 */
function reportSweepHit(hit: SweepHit): void {
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: 'warn',
      msg:
        `data-protection log sweep redacted ${hit.count} ${hit.pattern} value(s) — a field ` +
        'reached the logger with no data_protection_policies row. Add one ' +
        '(07-DATA-PROTECTION.md §7) rather than relying on the sweep, which matches shape and ' +
        'will not catch the same value in another form.',
      sweep: { pattern: hit.pattern, count: hit.count, callSite: hit.callSite },
      service: SERVICE_NAME,
    })}\n`,
  );
}

/**
 * `msg` as a string.
 *
 * Nest's `Logger.log()` accepts anything, so `message` can arrive as an object or an `Error`.
 * A structured field whose type varies between lines is unqueryable, so it is normalised here —
 * an `Error` to its message (the stack travels separately, on `stack`), and anything else to its
 * JSON form, never `String(value)`, whose answer for an object is `[object Object]`.
 */
function normaliseMessage(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.message;
  try {
    return JSON.stringify(message) ?? String(message);
  } catch {
    return '[UNSERIALISABLE]';
  }
}
