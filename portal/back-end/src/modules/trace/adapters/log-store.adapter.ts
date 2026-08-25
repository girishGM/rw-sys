/**
 * T-045 — the pluggable log-store seam (implementation note 2: *"the log store via a pluggable
 * adapter (file adapter for local, HTTP adapter for a real log backend)"*), and implementation
 * note 3's graceful degradation: *"Missing sources degrade gracefully... return the others with
 * `logLines: null`."*
 *
 * `08-OBSERVABILITY.md §3`'s structured log lines are the **only** place the §5 waterfall lives —
 * `CorrelationMiddleware` writes it into the "request completed" line and nowhere else — so this
 * is the one source of the four this endpoint reads that this codebase has not already built a
 * queryable store for. Every implementation below answers with `null`, never a thrown error, when
 * it cannot produce lines: `null` is the signal `trace.service.ts` reads as "this source is
 * unavailable", and a throw here would turn an unreachable log backend into a 500 for an endpoint
 * whose entire point is to still work when part of the story is missing.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { RawLogLine } from '../trace-assembly';

/** DI token — consumers depend on {@link LogStoreAdapter}, never on a concrete class. */
export const LOG_STORE_ADAPTER = Symbol('LOG_STORE_ADAPTER');

export interface LogStoreAdapter {
  /**
   * Every log line carrying `correlationId`, oldest first, capped at `limit`.
   *
   * Returns `null` — never throws — when the store could not be reached at all (file missing,
   * HTTP backend down, request timed out). Returns `[]`, not `null`, when the store was reached
   * and genuinely has nothing for this id — that distinction is what lets `trace.service.ts` tell
   * "the log store is down" (TC-5) apart from "this id produced no log lines" (part of TC-6).
   */
  fetchLines(correlationId: string, limit: number): Promise<readonly RawLogLine[] | null>;
}

/**
 * The default binding: no adapter configured (implementation note 3's steady state until an
 * operator sets `TRACE_LOG_STORE`). Always `null` — "not configured" is reported by
 * `trace.service.ts` as `sources.logStore: 'not_configured'` rather than `'unavailable'`, which
 * this adapter cannot distinguish on its own; see `trace.service.ts`.
 */
@Injectable()
export class NullLogStoreAdapter implements LogStoreAdapter {
  async fetchLines(_correlationId: string, _limit: number): Promise<null> {
    return Promise.resolve(null);
  }
}

/**
 * Reads a local JSONL log file — one `08-OBSERVABILITY.md §3` object per line, exactly what
 * `logger.config.ts`'s `format.json()` writes to its console transport when that output is
 * redirected to a file. The intended local-development shape: `npm run start:dev > app.log &`,
 * `TRACE_LOG_STORE=file`, `TRACE_LOG_FILE_PATH=./app.log`.
 *
 * Streamed line-by-line (`readline`) rather than read whole and split, so an operator's
 * multi-gigabyte log file does not have to fit in process memory to answer one query — the whole
 * reason this endpoint has a row cap at all (implementation note 8) is that "assemble everything"
 * is not a safe default for a log store, file-backed or not.
 */
@Injectable()
export class FileLogStoreAdapter implements LogStoreAdapter {
  private readonly logger = new Logger(FileLogStoreAdapter.name);

  constructor(private readonly filePath: string) {}

  async fetchLines(correlationId: string, limit: number): Promise<readonly RawLogLine[] | null> {
    if (!existsSync(this.filePath)) {
      this.logger.warn(
        `Trace log file not found at ${this.filePath}; reporting logStore unavailable.`,
      );
      return null;
    }

    const matches: RawLogLine[] = [];
    try {
      const stream = createReadStream(this.filePath, { encoding: 'utf8' });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });

      for await (const raw of lines) {
        if (raw.trim().length === 0) continue;
        const parsed = parseLogLine(raw);
        if (parsed === null || parsed.correlationId !== correlationId) continue;

        matches.push(parsed);
        // `limit` is the caller's exact cap (`RowBudget.fetchLimit()` already adds the "one more
        // than the remaining budget" the caller needs to detect overflow) — this adapter's own
        // contract is simply "never return more than `limit`".
        if (matches.length >= limit) break;
      }
    } catch (error) {
      this.logger.warn(
        `Trace log file read failed (${(error as Error).message}); reporting logStore unavailable.`,
      );
      return null;
    }

    return matches;
  }
}

/**
 * Queries an HTTP log backend — the shape a real deployment (T-052's aggregator) is expected to
 * use. The wire contract is intentionally minimal: `GET <url>?correlationId=<id>&limit=<n>`
 * returning a JSON array of §3-shaped objects. A specific backend's own query language is not
 * this task's to design; this adapter is the seam T-052 replaces or extends.
 */
@Injectable()
export class HttpLogStoreAdapter implements LogStoreAdapter {
  private readonly logger = new Logger(HttpLogStoreAdapter.name);

  constructor(
    private readonly baseUrl: string,
    private readonly authToken: string | null,
    /** Milliseconds. A trace view must not hang the request indefinitely on a slow backend. */
    private readonly timeoutMs = 3000,
  ) {}

  async fetchLines(correlationId: string, limit: number): Promise<readonly RawLogLine[] | null> {
    const url = new URL(this.baseUrl);
    url.searchParams.set('correlationId', correlationId);
    url.searchParams.set('limit', String(limit));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: this.authToken === null ? {} : { Authorization: `Bearer ${this.authToken}` },
      });

      if (!response.ok) {
        this.logger.warn(
          `Trace log HTTP backend answered ${response.status}; reporting unavailable.`,
        );
        return null;
      }

      const body: unknown = await response.json();
      // `limit` is a request hint, not a contract the backend is trusted to honour exactly — a
      // defensive `slice` keeps a misbehaving backend from silently defeating the row cap.
      return Array.isArray(body) ? body.filter(isRecord).slice(0, limit) : null;
    } catch (error) {
      this.logger.warn(
        `Trace log HTTP backend unreachable (${(error as Error).message}); reporting unavailable.`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** One line of the file adapter's input, parsed and shape-checked. `null` on anything malformed. */
function parseLogLine(raw: string): (RawLogLine & { correlationId: string }) | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  const correlationId = parsed.correlationId;
  if (typeof correlationId !== 'string') return null;

  return { ...parsed, correlationId };
}

function isRecord(value: unknown): value is RawLogLine {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
