/**
 * T-PC-042. A `LoggerService` implementation that emits one JSON object per line (a "structured
 * (JSON) logging setup with a consistent field schema across every module") instead of Nest's
 * default human-readable `ConsoleLogger` text format.
 *
 * Installed process-wide via `Logger.overrideLogger(...)` (`logging.module.ts`), which is the
 * same, fully-supported mechanism `NestFactory`'s own `app.useLogger(...)` uses under the hood
 * (`@nestjs/common`'s `Logger.overrideLogger` sets a static `staticInstanceRef` every
 * `new Logger(context)` instance elsewhere in the codebase already delegates to) — this is why
 * every existing `private readonly logger = new Logger(SomeClass.name)` call site in this
 * project (none of them owned by this task) starts emitting structured JSON too, without this
 * task ever editing that call site's file.
 *
 * TC-11 ("no raw `console.log` in application code outside the logging module") is satisfied by
 * construction here: this file writes with `process.stdout.write`/`process.stderr.write`
 * directly, never `console.*` — the one place in the whole codebase allowed to touch the raw
 * output stream at all.
 */
import { Injectable, type LoggerService, type LogLevel } from '@nestjs/common';
import { CorrelationContextService } from './correlation-context.service';

interface StructuredLogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: string;
  correlationId?: string;
  tenantId?: string;
  transport?: string;
  rpc?: string;
  stack?: string;
}

const ERROR_LEVELS: ReadonlySet<LogLevel> = new Set(['error', 'fatal']);

function stringifyMessage(message: unknown): string {
  if (typeof message === 'string') {
    return message;
  }
  if (message instanceof Error) {
    return message.message;
  }
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

/**
 * Nest's own `Logger` instance methods (`logger.service.js`) append the constructor's `context`
 * string as the *last* element of `optionalParams` (`error` prepends `undefined` first when no
 * other params were passed) — this mirrors that exact convention so every existing call site's
 * `context` still ends up in the structured `context` field, not swallowed as a stray positional
 * arg.
 */
function extractContextAndStack(
  level: LogLevel,
  optionalParams: unknown[],
): { context?: string; stack?: string } {
  if (optionalParams.length === 0) {
    return {};
  }
  const last = optionalParams[optionalParams.length - 1];
  const context = typeof last === 'string' ? last : undefined;
  if (ERROR_LEVELS.has(level)) {
    const rest = context === undefined ? optionalParams : optionalParams.slice(0, -1);
    const stackCandidate = rest.find((param) => typeof param === 'string') as string | undefined;
    return { context, stack: stackCandidate };
  }
  return { context };
}

@Injectable()
export class StructuredLoggerService implements LoggerService {
  constructor(private readonly correlationContext: CorrelationContextService) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('log', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('verbose', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  private write(level: LogLevel, message: unknown, optionalParams: unknown[]): void {
    const { context, stack } = extractContextAndStack(level, optionalParams);
    const correlation = this.correlationContext.getCurrent();

    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: stringifyMessage(message),
      ...(context ? { context } : {}),
      ...(correlation?.correlationId ? { correlationId: correlation.correlationId } : {}),
      ...(correlation?.tenantId ? { tenantId: correlation.tenantId } : {}),
      ...(correlation?.transport ? { transport: correlation.transport } : {}),
      ...(correlation?.rpc ? { rpc: correlation.rpc } : {}),
      ...(stack ? { stack } : {}),
    };

    const line = `${JSON.stringify(entry)}\n`;
    if (ERROR_LEVELS.has(level)) {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }
}
