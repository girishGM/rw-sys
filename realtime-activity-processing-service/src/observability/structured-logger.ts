/**
 * T-RAP-043. `StructuredLogger` — every log line this service ever writes carries `correlationId`
 * (and, when known, `tenantId`/`campaignCode`) as **separate JSON fields**, never string-
 * interpolated into the free-text `message` (`06-CONFIGURABILITY-AND-OBSERVABILITY.md` §3's own
 * "never string-interpolated ... so a future observability backend can filter/aggregate on them
 * without parsing"). One JSON object per line (`JSON.stringify`, no pretty-printing) is this task's
 * own choice of "structured" — trivially machine-parseable, and exactly what a future log
 * aggregator (`BACKLOG.md` B-2) expects without this service picking a specific backend SDK
 * (Winston/Pino/etc. are not a dependency of this project, `package.json` being outside this task's
 * file scope, `AGENT-PROTOCOL.md` R10).
 *
 * `correlationId` is **required on every call** (`06-CONFIGURABILITY-AND-OBSERVABILITY.md` §1's own
 * "never redacted, in logs or anywhere else ... the entire point of tracing") — a call site with no
 * `correlationId` to hand is a bug at that call site, not something this logger silently tolerates
 * by omitting the field.
 *
 * `redactField` is a thin, ergonomic proxy onto the already-existing, config-driven
 * `LogRedactorService` (T-RAP-012) — this class does not re-implement redaction, it only makes the
 * one correct way to apply it (`06-CONFIGURABILITY-AND-OBSERVABILITY.md` §1) reachable from the same
 * object a call site is already logging through. Exactly like every existing call site
 * (`activity-ingestion.service.ts`'s own `logReceipt`), a caller decides *which* fields need
 * `redactField` before they ever reach `log`/`warn`/`error`/`debug` — this class does not guess.
 */
import { Injectable } from '@nestjs/common';
import {
  LogRedactorService,
  type LogRedactorContext,
} from '@/modules/encryption/log-redactor.service';

export type StructuredLogLevel = 'log' | 'debug' | 'warn' | 'error';

export interface StructuredLogFields {
  /** Required on every call — see this file's own header for why. */
  correlationId: string;
  tenantId?: number;
  campaignCode?: string;
  /** Any other structured field a call site wants attached (already redacted by the caller via
   * `redactField` where `06-CONFIGURABILITY-AND-OBSERVABILITY.md` §1 requires it). */
  [extra: string]: unknown;
}

interface StructuredLogEntry extends StructuredLogFields {
  timestamp: string;
  level: StructuredLogLevel;
  context: string;
  message: string;
}

/** Injected once per call site's own class, mirroring the `new Logger(SomeClass.name)` convention
 * already used everywhere in this codebase (`activity-ingestion.service.ts` et al.) — see
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

  /** Proxies `LogRedactorService.redact` — see this file's own header. Never call this for
   * `correlationId`: `LogRedactorService.redact`'s own header already documents that its generic,
   * config-driven mechanism has no way to special-case one literal field name, and this method
   * makes no attempt to either. */
  redactField(fieldName: string, value: string, context: LogRedactorContext = {}): string {
    return this.redactor.redact(fieldName, value, context);
  }

  private write(level: StructuredLogLevel, message: string, fields: StructuredLogFields): void {
    if (!fields.correlationId || fields.correlationId.trim().length === 0) {
      throw new Error(
        `StructuredLogger.${level}() requires a non-blank correlationId field ` +
          `(06-CONFIGURABILITY-AND-OBSERVABILITY.md §4) — none was supplied for context "${this.context}", message "${message}".`,
      );
    }

    // Base identity fields are spread first, `...fields` second, and the four structural fields
    // (timestamp/level/context/message) are written last so they always win over anything a caller
    // accidentally names the same in `fields` — never the other way around.
    const entry: StructuredLogEntry = {
      ...fields,
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
        // T-RAP-043: this class's whole job is emitting structured log lines; `.eslintrc.js`'s
        // `no-console` allowlist covers warn/error only.
        // eslint-disable-next-line no-console
        console.debug(line);
        break;
      default:
        // eslint-disable-next-line no-console -- T-RAP-043: see the `debug` case above.
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
