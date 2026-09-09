/**
 * T-RTS-040. `StructuredLogger`/`StructuredLoggerFactory`/`LoggingModule` — structured logging with
 * correlation-id propagation (`T-RTS-040-observability-wiring.md`'s own Objective), mirroring the
 * identical convention already established in `reward-redemption-service`
 * (`structured-logger.service.ts`) and `realtime-activity-processing-service`
 * (`structured-logger.ts`): every log line carries `correlationId` (propagated from the inbound
 * event's own `correlationId` field), and — when known — `tenantId`/`campaignCode`, as **separate
 * JSON fields**, never string-interpolated into the free-text `message`, so a future log
 * aggregator can filter/aggregate on them without parsing.
 *
 * **No config-driven `LogRedactorService` exists anywhere in this plan.** `T-RTS-010`'s own header
 * (`src/modules/ingestion/customer-id-crypto.service.ts`) already flagged this exact gap: unlike
 * `reward-redemption-service`/`realtime-activity-processing-service`, no Wave-0 foundation task here
 * built a `field_encryption_config`-backed `encryption` module with its own `LogRedactorService`,
 * and adding one is out of this task's own file scope (`src/database/migrations/**` is
 * `agent-rts-foundation`'s exclusive scope, R10). Rather than depend on a module that does not
 * exist, `StructuredLogger` below carries its own minimal, hard-coded guard as a defense-in-depth
 * layer on top of every call site already being disciplined about only ever logging
 * `customerIdHash`/`customerIdEncrypted` (R6, `reward-tracking-ingestion.service.ts`'s own header):
 * any log call whose `fields` object includes a literal `customerId` (or `customer_id`) key has
 * that value replaced with `[REDACTED]` before the line is ever serialized. This never throws — a
 * call-site mistake is masked, not a crash, matching R1's own "this service never gates/crashes on
 * a caller's mistake" spirit. Flagged as a deviation from the RR/RAP `LogRedactorService` pattern in
 * this task's completion report for the architect to reconcile later if a real `encryption` module
 * ever lands here.
 *
 * `correlationId` is required on every call — a call site with none to hand is a bug at that call
 * site, not something this logger silently tolerates by omitting the field.
 */
import { Injectable, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';

export type StructuredLogLevel = 'log' | 'debug' | 'warn' | 'error';

/** Field names this logger always redacts before emission, regardless of caller intent (this
 * file's own header explains why this exists in place of a config-driven `LogRedactorService`).
 * Append-only: removing an entry here would be a real R6 regression, never done casually. */
const ALWAYS_REDACTED_FIELD_NAMES: ReadonlySet<string> = new Set(['customerId', 'customer_id']);
const REDACTED_PLACEHOLDER = '[REDACTED]';

export interface StructuredLogFields {
  /** Required on every call — see this file's own header for why. */
  correlationId: string;
  tenantId?: number;
  campaignCode?: string;
  /** Any other structured field a call site wants attached. A literal `customerId`/`customer_id`
   * key is redacted automatically (see `ALWAYS_REDACTED_FIELD_NAMES` above) — a caller never needs
   * to remember to do this itself. */
  [extra: string]: unknown;
}

interface StructuredLogEntry extends Record<string, unknown> {
  timestamp: string;
  level: StructuredLogLevel;
  context: string;
  message: string;
}

/** Injected once per call site's own class, mirroring the `new Logger(SomeClass.name)` convention
 * already used everywhere in this codebase — see `StructuredLoggerFactory.forContext` below for the
 * DI-friendly way to obtain one. */
export class StructuredLogger {
  constructor(private readonly context: string) {}

  log(message: string, fields: StructuredLogFields): void {
    this.write('log', message, fields);
  }

  debug(message: string, fields: StructuredLogFields): void {
    this.write('debug', message, fields);
  }

  warn(message: string, fields: StructuredLogFields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields: StructuredLogFields): void {
    this.write('error', message, fields);
  }

  private write(level: StructuredLogLevel, message: string, fields: StructuredLogFields): void {
    if (!fields.correlationId || fields.correlationId.trim().length === 0) {
      throw new Error(
        `StructuredLogger.${level}() requires a non-blank correlationId field — none was ` +
          `supplied for context "${this.context}", message "${message}" (R6/observability contract).`,
      );
    }

    // Base identity fields are spread first, the four structural fields (timestamp/level/context/
    // message) are written last so they always win over anything a caller accidentally names the
    // same in `fields` — never the other way around.
    const entry: StructuredLogEntry = {
      ...this.redact(fields),
      timestamp: new Date().toISOString(),
      level,
      context: this.context,
      message,
    };

    const line = JSON.stringify(entry);
    switch (level) {
      case 'error':
        console.error(line);
        break;
      case 'warn':
        console.warn(line);
        break;
      case 'debug':
        // T-RTS-040: this class's whole job is emitting structured log lines; `.eslintrc.js`'s
        // `no-console` allowlist covers warn/error only.
        // eslint-disable-next-line no-console
        console.debug(line);
        break;
      default:
        // eslint-disable-next-line no-console -- T-RTS-040: see the `debug` case above.
        console.log(line);
    }
  }

  /** R6 — never emits a plaintext `customerId`/`customer_id` value, regardless of what a caller
   * passed. See this file's own header for why this exists in place of a config-driven redactor. */
  private redact(fields: StructuredLogFields): Record<string, unknown> {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      safe[key] = ALWAYS_REDACTED_FIELD_NAMES.has(key) ? REDACTED_PLACEHOLDER : value;
    }
    return safe;
  }
}

/** DI-friendly factory — `constructor(private readonly loggers: StructuredLoggerFactory) {}` then
 * `this.logger = this.loggers.forContext(SomeClass.name)`, the same shape every existing call site
 * already uses for `new Logger(SomeClass.name)`. */
@Injectable()
export class StructuredLoggerFactory {
  forContext(context: string): StructuredLogger {
    return new StructuredLogger(context);
  }
}

/**
 * Not wired into `AppModule` (`src/app.module.ts` is `agent-rts-foundation`'s exclusive file scope,
 * not this task's, R10). Every module that wants `MetricsService`/`StructuredLoggerFactory` imports
 * this module directly — the same "later tasks import this module directly" precedent
 * `campaign-cache.module.ts`'s own header already sets for its own exports.
 *
 * Exports `MetricsService` alongside the logging providers so a consumer needs exactly one import
 * (`LoggingModule`) to get this task's whole observability contract, rather than two.
 */
@Module({
  providers: [MetricsService, StructuredLoggerFactory],
  exports: [MetricsService, StructuredLoggerFactory],
})
export class LoggingModule {}
