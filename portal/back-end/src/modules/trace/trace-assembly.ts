/**
 * T-045 — the pure, DB-free half of trace assembly: the shared row budget (implementation note 8)
 * and the reconstruction of the §5 waterfall from a request's own "request completed" log line
 * (implementation note 6).
 *
 * Kept free of Nest, Sequelize and the adapters deliberately — everything here is a plain
 * function over plain data, so the cap-and-truncate arithmetic and the timeline reconstruction
 * are covered by fast, DB-free unit tests (`test/trace/trace-assembly.spec.ts`) rather than only
 * being provable through a slow end-to-end run with 6,000 real rows (TC-14).
 */
import { MAX_TRACE_ROWS, REQUEST_COMPLETION_MESSAGES, SLOW_SPAN_RATIO } from './trace.constants';

// --- the shared row budget (implementation note 8) ----------------------------------------------

/**
 * The state one trace assembly threads through every source it reads, in a fixed order.
 *
 * A class rather than a bare counter closure so `trace.service.ts` can hold one instance across
 * `await` boundaries between sources without re-deriving it, and so a unit test can inspect
 * `.truncated` and `.remaining` directly rather than inferring them from a side effect.
 */
export class RowBudget {
  private remainingRows: number;
  private hitCap = false;

  constructor(cap: number = MAX_TRACE_ROWS) {
    if (!Number.isInteger(cap) || cap < 0) {
      throw new Error(`RowBudget cap must be a non-negative integer, got ${String(cap)}`);
    }
    this.remainingRows = cap;
  }

  /** How many more rows this assembly may still accept. */
  remaining(): number {
    return this.remainingRows;
  }

  /** Whether the cap has been reached — implementation note 8's truncation notice. */
  truncated(): boolean {
    return this.hitCap;
  }

  /**
   * The `limit` a source's own query should ask for: one more than the remaining budget, so the
   * caller can tell "exactly filled the rest of the budget" apart from "there was more but the
   * cap stopped it" without a second round trip.
   *
   * `0` once the budget is exhausted — a source at that point should not query at all
   * (`RowBudget.exhausted()`), so this is only ever called for the answer, not as the guard.
   */
  fetchLimit(): number {
    return this.remainingRows + 1;
  }

  /** Whether any source further down the fixed order should bother querying at all. */
  exhausted(): boolean {
    return this.remainingRows <= 0;
  }

  /**
   * Applies one source's rows against the remaining budget, in place, and returns what the
   * response may actually carry.
   *
   * `rows` is expected to have been fetched with `limit: this.fetchLimit()` — one row beyond what
   * would fit — so that a source whose true result set is *exactly* the remaining budget is not
   * mistaken for one that was cut off (TC-14's "no false truncation notice" half).
   */
  take<T>(rows: readonly T[]): T[] {
    if (rows.length <= this.remainingRows) {
      this.remainingRows -= rows.length;
      return [...rows];
    }

    const kept = rows.slice(0, this.remainingRows);
    this.hitCap = true;
    this.remainingRows = 0;
    return kept;
  }
}

// --- reconstructing the §5 waterfall from a log line ---------------------------------------------

export interface DerivedActor {
  readonly userId: number | null;
  readonly role: string | null;
  readonly sessionId: string | null;
}

export interface DerivedScope {
  readonly countryId: number | null;
  readonly tenantId: number | null;
  readonly merchantId: number | null;
}

export interface DerivedSummary {
  readonly correlationId: string;
  readonly startedAt: string | null;
  readonly durationMs: number | null;
  readonly actor: DerivedActor | null;
  readonly scope: DerivedScope | null;
  readonly route: string | null;
  readonly status: number | null;
}

export type DerivedSpanStatus = 'ok' | 'error' | 'denied';

export interface DerivedSpan {
  readonly name: string;
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly status: DerivedSpanStatus;
  readonly spanId: string;
  /** > `SLOW_SPAN_RATIO` of the request's total duration (implementation note 6). */
  readonly slow: boolean;
  readonly attributes: Readonly<Record<string, string | number | boolean | null>> | null;
}

/** A log line as the log-store adapters hand it back: parsed JSON, shape unverified. */
export type RawLogLine = Record<string, unknown>;

/** An empty summary — every field but the id itself `null`. Used when no completion line exists. */
export function emptySummary(correlationId: string): DerivedSummary {
  return {
    correlationId,
    startedAt: null,
    durationMs: null,
    actor: null,
    scope: null,
    route: null,
    status: null,
  };
}

/**
 * Reconstructs §5's summary and waterfall from the log lines the log-store adapter returned for
 * one correlation id.
 *
 * ### Which line wins, when a correlation id spans several HTTP requests
 *
 * §1: *"A retried request keeps its `correlation_id` and gets a fresh `request_id`."* — so more
 * than one "request completed"/"request aborted" line can legitimately share one correlation id.
 * This function surfaces the **most recent** one as the summary and its spans as the timeline:
 * that is the outcome an operator investigating "what happened to this operation" almost always
 * wants (the final attempt, not the first), and every line — including the earlier retries — is
 * still returned untouched in the response's own `logLines`, so nothing is hidden, only
 * de-emphasised. Recorded as a deliberate simplification in the T-045 completion report.
 *
 * Never throws: a log line is untrusted, parsed JSON from an external store, and a malformed one
 * degrades to being skipped rather than failing the whole trace (the same fail-open-on-shape,
 * fail-closed-on-security posture `log-masking.serializer.ts` takes with a throwing getter).
 */
export function deriveTimeline(
  correlationId: string,
  logLines: readonly RawLogLine[] | null,
): { summary: DerivedSummary; spans: readonly DerivedSpan[] } {
  if (logLines === null || logLines.length === 0) {
    return { summary: emptySummary(correlationId), spans: [] };
  }

  const completionLines = logLines.filter(isCompletionLine);
  if (completionLines.length === 0) {
    return { summary: emptySummary(correlationId), spans: [] };
  }

  const latest = completionLines.reduce((best, candidate) =>
    tsOf(candidate) !== null && (tsOf(best) === null || tsOf(candidate)! > tsOf(best)!)
      ? candidate
      : best,
  );

  const summary = summaryOf(correlationId, latest);
  const spans = spansOf(latest, summary.durationMs);
  return { summary, spans };
}

function isCompletionLine(line: RawLogLine): boolean {
  const msg = line.msg;
  return (
    typeof msg === 'string' && (REQUEST_COMPLETION_MESSAGES as readonly string[]).includes(msg)
  );
}

function tsOf(line: RawLogLine): number | null {
  const ts = line.ts;
  if (typeof ts !== 'string') return null;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? null : parsed;
}

function summaryOf(correlationId: string, line: RawLogLine): DerivedSummary {
  const http = asRecord(line.http);
  const durationMs = asNumber(http?.durationMs);
  const completedAtMs = tsOf(line);

  return {
    correlationId,
    // The line is written once the response is sent, so `ts` is the *end* of the request; the
    // start is derived from it and the measured duration rather than logged separately.
    startedAt:
      completedAtMs !== null && durationMs !== null
        ? new Date(completedAtMs - durationMs).toISOString()
        : null,
    durationMs,
    actor: actorOf(line.actor),
    scope: scopeOf(line.scope),
    route: asString(http?.route),
    status: asNumber(http?.status),
  };
}

function actorOf(value: unknown): DerivedActor | null {
  const record = asRecord(value);
  if (record === null) return null;
  return {
    userId: asNumber(record.userId),
    role: asString(record.role),
    sessionId: asString(record.sessionId),
  };
}

function scopeOf(value: unknown): DerivedScope | null {
  const record = asRecord(value);
  if (record === null) return null;
  return {
    countryId: asNumber(record.countryId),
    tenantId: asNumber(record.tenantId),
    merchantId: asNumber(record.merchantId),
  };
}

function spansOf(line: RawLogLine, totalDurationMs: number | null): readonly DerivedSpan[] {
  const raw = line.spans;
  if (!Array.isArray(raw)) return [];

  const threshold =
    totalDurationMs !== null && totalDurationMs > 0 ? totalDurationMs * SLOW_SPAN_RATIO : null;

  const spans: DerivedSpan[] = [];
  for (const entry of raw) {
    const span = spanOf(entry, threshold);
    if (span !== null) spans.push(span);
  }
  return spans;
}

function spanOf(entry: unknown, slowThresholdMs: number | null): DerivedSpan | null {
  const record = asRecord(entry);
  if (record === null) return null;

  const name = asString(record.name);
  const startedAtMs = asNumber(record.startedAtMs);
  const durationMs = asNumber(record.durationMs);
  const spanId = asString(record.spanId);
  const status = asSpanStatus(record.status);
  if (name === null || startedAtMs === null || durationMs === null || spanId === null) return null;

  return {
    name,
    startedAtMs,
    durationMs,
    status: status ?? 'ok',
    spanId,
    slow: slowThresholdMs !== null && durationMs > slowThresholdMs,
    attributes: attributesOf(record.attributes),
  };
}

function attributesOf(
  value: unknown,
): Readonly<Record<string, string | number | boolean | null>> | null {
  const record = asRecord(value);
  if (record === null) return null;

  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(record)) {
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean'
    ) {
      out[key] = item;
    }
  }
  return out;
}

function asSpanStatus(value: unknown): DerivedSpanStatus | null {
  return value === 'ok' || value === 'error' || value === 'denied' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
