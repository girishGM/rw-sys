/**
 * T-019 — the W3C Trace Context wire format: `traceparent` in, `traceparent` out.
 *
 * 08-OBSERVABILITY.md §1 names three identifiers with three distinct jobs, and this file owns the
 * third of them:
 *
 * > | `trace_id` / `span_id` | W3C `traceparent` | OpenTelemetry | Distributed timing and the
 * > waterfall view |
 *
 * ---
 *
 * ## Why this is a 90-line parser and not `@opentelemetry/*`
 *
 * The task's scope line says "OpenTelemetry wiring", and the honest reading of that in Wave 1 is
 * **the wire format**, not the SDK. Three reasons, recorded here because the next person will
 * reasonably ask:
 *
 *  1. **No OTel package is installed**, and none is in `back-end/package.json`. Adding the SDK is
 *     six to ten transitive dependencies plus an exporter and a collector endpoint to point them
 *     at — infrastructure that 08-OBSERVABILITY.md §7 assigns to T-052 ("Traces (OTel) — 7 days
 *     full, 90 days sampled"), together with the metrics and dashboards that would consume them.
 *     Implementation note 6a of this task file is explicit about the same instinct for the logger
 *     ("do not introduce `pino` or any other library"); shipping a tracing SDK with nowhere to
 *     export to would be the same mistake in the other direction.
 *  2. **The part that must exist now is interoperability**, and that is entirely wire-format. A
 *     `traceparent` this process accepts from an upstream service, and the one it forwards to a
 *     downstream one (TC-22), have to be byte-correct against the W3C recommendation whether or
 *     not an SDK is present. That is what this file guarantees and what its tests assert.
 *  3. **It leaves a seam of exactly one shape.** T-052 installs the SDK, and the only thing that
 *     changes here is where {@link newTraceId}/{@link newSpanId} come from — every consumer reads
 *     ids through {@link TraceContext}, not from an SDK global.
 *
 * Flagged as a deviation in the completion report so the architect can overrule it.
 *
 * ## What "validate before use" means for a `traceparent`
 *
 * The same argument the correlation id gets (§1: *"an unvalidated header goes straight into log
 * lines, and a newline in it is log injection"*) applies verbatim to this header — it is
 * attacker-controlled, it ends up in log lines, and it ends up in an outbound request header. The
 * pattern below is fully anchored and hex-only, so a value that parses **cannot** contain a
 * newline, a quote or `*​/`. Anything that does not parse is discarded and a fresh trace is
 * started; nothing is ever sanitised-and-kept.
 *
 * The two all-zero rejections are not pedantry: `00000…0` is the W3C "invalid" sentinel, and
 * accepting it would make every unrelated request share one trace id, which is the one failure
 * mode that makes a distributed trace store useless rather than merely incomplete.
 */
import { randomBytes } from 'node:crypto';

/** The W3C header carrying the parent trace/span. Lower-case: Node normalises request headers. */
export const TRACEPARENT_HEADER = 'traceparent';

/** The vendor-extension companion header. Forwarded verbatim only when it is well-formed. */
export const TRACESTATE_HEADER = 'tracestate';

/** The version this implementation emits. W3C `00` is the only version defined today. */
export const TRACEPARENT_VERSION = '00';

/** `sampled`, bit 0 of the trace-flags octet. The only flag W3C defines. */
export const TRACE_FLAG_SAMPLED = 0x01;

/**
 * `version "-" trace-id "-" parent-id "-" trace-flags`, all lower-case hex.
 *
 * Version `ff` is forbidden by the specification and is rejected by the character class. Versions
 * other than `00` are accepted for their first four fields and any trailing content is ignored,
 * which is what the specification requires of a receiver that does not know a future version —
 * dropping a trace because a newer agent upstream added a field would silently break the very
 * end-to-end property this file exists to provide.
 */
const TRACEPARENT_PATTERN =
  /^(?<version>[0-9a-f]{2})-(?<traceId>[0-9a-f]{32})-(?<spanId>[0-9a-f]{16})-(?<flags>[0-9a-f]{2})(?<rest>-.*)?$/;

/** W3C: 32 hex zeros is the "no trace" sentinel and is never a valid trace id. */
const INVALID_TRACE_ID = '0'.repeat(32);
/** W3C: 16 hex zeros is likewise never a valid span id. */
const INVALID_SPAN_ID = '0'.repeat(16);

/**
 * `tracestate` is opaque to us, so it is forwarded only if it is safe to put in a header and a
 * log line: printable ASCII, no control characters, and bounded at the 512 bytes the
 * specification recommends as the limit a propagator should keep.
 */
const TRACESTATE_PATTERN = /^[\x20-\x7e]{1,512}$/;

/** A parsed, validated upstream `traceparent`. */
export interface TraceParent {
  readonly traceId: string;
  /** The upstream span, which becomes *this* request's parent span. */
  readonly spanId: string;
  readonly sampled: boolean;
}

/** 16 random bytes as lower-case hex — a W3C trace id. Never {@link INVALID_TRACE_ID}. */
export function newTraceId(): string {
  return randomHex(16);
}

/** 8 random bytes as lower-case hex — a W3C span id. Never {@link INVALID_SPAN_ID}. */
export function newSpanId(): string {
  return randomHex(8);
}

/**
 * A validated upstream `traceparent`, or `null`.
 *
 * `null` covers absent, malformed, duplicated (Node gives `string[]` when a header arrives twice,
 * which no legitimate client does) and the two all-zero sentinels. Every one of those means the
 * same thing to the caller — *start a new trace* — so they are deliberately not distinguished.
 */
export function parseTraceparent(value: unknown): TraceParent | null {
  if (typeof value !== 'string') return null;

  const match = TRACEPARENT_PATTERN.exec(value);
  if (match?.groups === undefined) return null;

  const { version, traceId, spanId, flags, rest } = match.groups;

  // `ff` is reserved-invalid; and version `00` forbids trailing fields, so a `00` header with
  // extra content is malformed rather than forward-compatible.
  if (version === 'ff') return null;
  if (version === TRACEPARENT_VERSION && rest !== undefined) return null;

  if (traceId === INVALID_TRACE_ID || spanId === INVALID_SPAN_ID) return null;

  return {
    traceId,
    spanId,
    sampled: (Number.parseInt(flags, 16) & TRACE_FLAG_SAMPLED) !== 0,
  };
}

/** The header value for this process's own span. The inverse of {@link parseTraceparent}. */
export function formatTraceparent(traceId: string, spanId: string, sampled: boolean): string {
  const flags = sampled ? '01' : '00';
  return `${TRACEPARENT_VERSION}-${traceId}-${spanId}-${flags}`;
}

/** `tracestate` if it is safe to forward unchanged, else `null`. See {@link TRACESTATE_PATTERN}. */
export function sanitiseTracestate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return TRACESTATE_PATTERN.test(value) ? value : null;
}

/**
 * The headers an outbound call must carry so the far end joins this request's story (TC-22).
 *
 * Both families are sent, because they answer different questions: `traceparent` gives the far
 * end its place in the timing waterfall, and `X-Correlation-Id` gives an operator the one value
 * 08-OBSERVABILITY.md §1 says they actually search by. Sending only the first would leave a
 * cross-service search depending on a trace store being reachable; sending only the second would
 * lose the waterfall.
 *
 * `X-Request-Id` is **not** sent: it identifies *this* HTTP request, and the callee's request is
 * a different one. §1's table is explicit that a retry keeps the correlation id and gets a fresh
 * request id, and the same reasoning applies across a service hop.
 */
export function outboundTraceHeaders(context: {
  correlationId: string;
  traceId: string;
  /** The span the outbound call is made from — its `spanId` is the callee's parent. */
  spanId: string;
  sampled: boolean;
  tracestate?: string | null;
}): Record<string, string> {
  const headers: Record<string, string> = {
    [TRACEPARENT_HEADER]: formatTraceparent(context.traceId, context.spanId, context.sampled),
    'x-correlation-id': context.correlationId,
  };

  const tracestate = sanitiseTracestate(context.tracestate);
  if (tracestate !== null) headers[TRACESTATE_HEADER] = tracestate;

  return headers;
}

/**
 * `bytes` random bytes as lower-case hex, with the all-zero sentinel excluded **by construction**
 * rather than by a retry.
 *
 * Emitting `0000…0` would be emitting the W3C "invalid" value as if it were a real id, and every
 * downstream consumer is entitled to read that as "no trace". The obvious guard is
 * `while (hex === forbidden) regenerate`, and it is deliberately not used: that branch is
 * unreachable at 2⁻¹²⁸, so it can never be executed by a test, and this module is held to 100%
 * branch coverage. Setting the low bit of the first byte makes the sentinel impossible with no
 * branch at all, at a cost of one bit of entropy out of 128 (trace id) or 64 (span id) — which
 * changes a collision probability nobody can measure into one nobody can measure.
 */
function randomHex(bytes: number): string {
  const buffer = randomBytes(bytes);
  buffer[0] |= 0x01;
  return buffer.toString('hex');
}
