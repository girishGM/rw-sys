/**
 * T-RR-040. `StructuredLogger`/`StructuredLoggerFactory` — every log line concerning a reward entry
 * carries `correlationId`/`tenantId`/`campaignCode`/`rewardEntryId` as separate, structured JSON
 * fields, never string-interpolated into the free-text `message`
 * (`07-CONFIGURABILITY-AND-OBSERVABILITY.md` §2), mirroring RAP's own `StructuredLogger`
 * (`realtime-activity-processing-service/src/observability/structured-logger.ts`, confirmed by direct
 * read) — one JSON object per line, no external logging dependency (`package.json` is
 * `agent-rr-foundation`'s file scope, not this task's, `AGENT-PROTOCOL.md` R10).
 *
 * `correlationId` is required on every call (§4's own "never redacted ... the entire point of
 * tracing") — a call site with no `correlationId` to hand is a bug at that call site, not something
 * this logger silently tolerates by omitting the field.
 *
 * Every field passes through `LogRedactorService.redactFields` before being written — the
 * defense-in-depth layer that file's own header describes — so a caller does not have to remember to
 * pre-redact `customerId` itself for the guarantee to hold (TC-2).
 */
import { Injectable } from '@nestjs/common';
import { LogRedactorService } from './log-redactor.service';

export type StructuredLogLevel = 'log' | 'debug' | 'warn' | 'error';

export interface StructuredLogFields {
  /** Required on every call — see this file's own header for why. */
  correlationId: string;
  tenantId?: number;
  campaignCode?: string;
  rewardEntryId?: string;
  /** Any other structured field a call site wants attached — passed through
   * `LogRedactorService.redactFields` exactly like the four named fields above. */
  [extra: string]: unknown;
}

interface StructuredLogEntry extends Record<string, unknown> {
  timestamp: string;
  level: StructuredLogLevel;
  context: string;
  message: string;
}

/** Injected once per call site's own class, mirroring the `new Logger(SomeClass.name)` convention
 * already used everywhere in this codebase (`RewardIngestionService` et al.) — see
 * `StructuredLoggerFactory.forContext` below for the DI-friendly way to obtain one. */
export class StructuredLogger {
  constructor(
    private readonly context: string,
    private readonly redactor: LogRedactorService,
  ) {}

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
        `StructuredLogger.${level}() requires a non-blank correlationId field ` +
          `(07-CONFIGURABILITY-AND-OBSERVABILITY.md §4) — none was supplied for context ` +
          `"${this.context}", message "${message}".`,
      );
    }

    const redactedFields = this.redactor.redactFields(fields);

    // Structural fields are written last so they always win over anything a caller accidentally
    // names the same in `fields` — never the other way around.
    const entry: StructuredLogEntry = {
      ...redactedFields,
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
        // T-RR-040: this class's whole job is emitting structured log lines; `.eslintrc.js`'s
        // `no-console` allowlist covers warn/error only.
        // eslint-disable-next-line no-console
        console.debug(line);
        break;
      default:
        // T-RR-040: see the `debug` case above.
        // eslint-disable-next-line no-console
        console.log(line);
    }
  }
}

/** DI-friendly factory — `constructor(private readonly loggers: StructuredLoggerFactory) {}` then
 * `this.logger = this.loggers.forContext(SomeClass.name)`, the same shape every existing call site
 * already uses for `new Logger(SomeClass.name)`. */
@Injectable()
export class StructuredLoggerFactory {
  constructor(private readonly redactor: LogRedactorService) {}

  forContext(context: string): StructuredLogger {
    return new StructuredLogger(context, this.redactor);
  }
}
