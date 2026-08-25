/**
 * T-014 — position 12 of 00-ARCHITECTURE.md §6: *"strips internals, returns a `system_messages`
 * key"*. The last thing that touches a failed request, and the only thing that decides what a
 * client is told about it.
 *
 * ### The property this filter exists to guarantee
 *
 * > **Nothing a client receives is derived from the text of an error.**
 *
 * Not the message, not the constraint name, not the SQL, not the file path, not the stack. The
 * body is *constructed* from three things: a code that passed {@link isSafeErrorCode}, that
 * code's text from `system_messages`, and a trace id. Everything else — the real error, its
 * stack, the SQL that failed — goes to the server log, which is where an engineer can act on it
 * and an attacker cannot read it (TC-8, TC-10, TC-12).
 *
 * That is a *structural* guarantee rather than a filtering one, and the distinction matters.
 * A filter that scrubbed dangerous substrings out of `error.message` would be one unfamiliar
 * error format away from leaking; this one has no code path that copies an exception's message
 * into a response at all. The `system_messages` indirection (01-DATABASE.md §5.4, T004_004) is
 * what makes that possible: there is always a safe thing to say.
 *
 * ### What it recognises, in order
 *
 * | Thrown | Response |
 * |---|---|
 * | {@link AppError} (this task, and Wave 3 services) | its own `code`/`status`/`details` |
 * | `HttpException` already carrying `{ error: { code } }` (T-011/T-012/T-013) | that `code`, unchanged |
 * | `ValidationFailedError` from the pipe's `exceptionFactory` | 400 + `details: [{field, code}]` |
 * | any other `HttpException` (Nest's own `NotFoundException`, a 404 from the router, …) | status → catalogue code |
 * | `UniqueConstraintError` | 409 `DUPLICATE_RESOURCE` — **never** the constraint name (TC-9) |
 * | `ForeignKeyConstraintError` | 409 `RELATED_RESOURCE_MISSING` |
 * | any other Sequelize error | 500 `INTERNAL_ERROR` — no table, no column, no SQL (TC-10) |
 * | anything at all, including a bare `TypeError` | 500 `INTERNAL_ERROR` + `traceId` (TC-8) |
 *
 * ### Why it also writes audit rows
 *
 * `AuditInterceptor` writes on success only (implementation note 2), and a Nest **guard** throws
 * *before* any interceptor runs — `RouterProxy.createProxy` catches the guard's exception and
 * hands it straight to the exception layer, so there is no interceptor in the call path of a
 * permission denial to observe it. The exception filter is therefore the only component that
 * sees every authorisation failure, which is why TC-2 (`login_failure`) and TC-3
 * (`permission_denied`) are served from here. See `audit.service.ts` `recordRequestFailure`.
 *
 * The audit write is awaited **before** the response is sent, deliberately: a security event
 * that lands after the client has already been told "denied" is a race in every test that
 * asserts on it and a hole in every incident timeline that reads it. It cannot fail the request
 * — `recordRequestFailure` never throws (implementation note 4).
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  BaseError as SequelizeBaseError,
  ForeignKeyConstraintError,
  UniqueConstraintError,
} from 'sequelize';
import type { AuthenticatedRequest } from '@/modules/auth/decorators/current-user.decorator';
import { redactForLog } from '@/common/logging/redact';
import { AuditService } from '@/common/audit/audit.service';
import { MessageService } from '@/common/messages/message.service';
import {
  ERROR_CODE,
  isAppError,
  isSafeDetail,
  isSafeErrorCode,
  type ErrorBody,
  type ErrorDetail,
} from './app-error';
import { resolveTraceId } from './trace-id';

/**
 * Status → catalogue code, for `HttpException`s raised by Nest itself or by a handler that threw
 * `new ForbiddenException()` rather than a typed error.
 *
 * Every entry is a code some earlier task already defined, so the client sees one vocabulary
 * regardless of which layer refused. Anything not listed becomes `INTERNAL_ERROR` if it is a
 * 5xx, and `CONFLICT`/`BUSINESS_RULE_VIOLATION`/… only where a mapping is genuinely unambiguous.
 */
const STATUS_CODE_MAP: Readonly<Record<number, string>> = Object.freeze({
  [HttpStatus.BAD_REQUEST]: ERROR_CODE.VALIDATION_FAILED,
  [HttpStatus.UNAUTHORIZED]: ERROR_CODE.AUTH_SESSION_INVALID,
  [HttpStatus.FORBIDDEN]: ERROR_CODE.PERM_DENIED,
  [HttpStatus.NOT_FOUND]: ERROR_CODE.NOT_FOUND,
  [HttpStatus.CONFLICT]: ERROR_CODE.CONFLICT,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ERROR_CODE.BUSINESS_RULE_VIOLATION,
  [HttpStatus.TOO_MANY_REQUESTS]: ERROR_CODE.RATE_LIMITED,
  [HttpStatus.SERVICE_UNAVAILABLE]: ERROR_CODE.SERVICE_UNAVAILABLE,
});

/** What {@link ErrorNormalizationFilter.classify} decides, before any text is looked up. */
interface Classification {
  readonly status: number;
  readonly code: string;
  readonly details?: readonly ErrorDetail[];
}

@Injectable()
@Catch()
export class ErrorNormalizationFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorNormalizationFilter.name);

  constructor(
    private readonly messages: MessageService,
    private readonly audit: AuditService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    // Non-HTTP contexts (T-047's gRPC port, the scheduler) have no response to write. Rethrowing
    // would be wrong — Nest is already unwinding — so the error is logged and left to the
    // transport's own handling.
    if (host.getType() !== 'http') {
      this.logger.error(
        `Unhandled ${describe(exception)} outside an HTTP context`,
        stackOf(exception),
      );
      return;
    }

    const http = host.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();

    const classification = this.classify(exception);
    const traceId = resolveTraceId(request);

    this.log(exception, request, classification, traceId);

    // Ordering: the audit row is written before the client is answered. See the header.
    //
    // `then(respond, respond)` rather than `then(respond)`: an *unhandled rejection* on this
    // path would terminate the process under Node's default `--unhandled-rejections=throw`.
    // `recordRequestFailure` is documented never to reject and is tested for it, but this is the
    // last line of the last layer — the one place where "it cannot happen" being wrong takes the
    // whole server down rather than one request. `respond` is itself total (see below).
    const respond = (): void => this.respond(response, classification, traceId);

    void this.audit
      .recordRequestFailure({
        request,
        status: classification.status,
        code: classification.code,
        traceId,
      })
      .then(respond, respond);
  }

  /**
   * {@link send}, with the guarantee that it cannot throw.
   *
   * `response.json()` can fail — a socket closed by the client mid-write, a serialiser that
   * throws. There is nothing useful to do about it except record that this request never got its
   * answer, and nothing worse to do than let it become an unhandled rejection.
   */
  private respond(response: Response, classification: Classification, traceId: string): void {
    try {
      this.send(response, classification, traceId);
    } catch (error) {
      this.logger.error(
        `Failed to write the error response for traceId=${traceId}: ${describe(error)}`,
        stackOf(error),
      );
    }
  }

  // --- classification ----------------------------------------------------------------------

  /**
   * Decides status and code. **Reads no message text from any exception.**
   *
   * Ordered most-specific first. `UniqueConstraintError` is checked before
   * `ForeignKeyConstraintError` and both before `SequelizeBaseError`, because Sequelize's error
   * classes form an inheritance chain and a `instanceof BaseError` test would swallow both.
   */
  private classify(exception: unknown): Classification {
    if (isAppError(exception)) {
      return { status: exception.status, code: exception.code, details: exception.details };
    }

    if (exception instanceof HttpException) {
      return this.classifyHttpException(exception);
    }

    // TC-9: a business code, not the raw constraint name (`uq_tc_tenant_code` tells a client
    // which columns are unique, i.e. part of the schema).
    if (exception instanceof UniqueConstraintError) {
      return { status: HttpStatus.CONFLICT, code: ERROR_CODE.DUPLICATE_RESOURCE };
    }

    if (exception instanceof ForeignKeyConstraintError) {
      return { status: HttpStatus.CONFLICT, code: ERROR_CODE.RELATED_RESOURCE_MISSING };
    }

    // TC-10: every other database failure — `DatabaseError`, `ConnectionError`, a timeout — is a
    // 500 with nothing in it. Their messages carry table names, column names and often the
    // statement itself.
    if (exception instanceof SequelizeBaseError) {
      return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: ERROR_CODE.INTERNAL_ERROR };
    }

    // TC-8: a bare `TypeError` from a service, or anything else at all.
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: ERROR_CODE.INTERNAL_ERROR };
  }

  /**
   * An `HttpException`'s *body* is inspected; its `message` never is.
   *
   * T-011, T-012 and T-013 already construct `{ error: { code, details? } }` bodies (each of
   * those files explains why it could not wait for this filter). Those pass straight through
   * with their code intact — which is what makes, for example, T-012's requirement that all four
   * login failures be byte-identical survive this layer.
   */
  private classifyHttpException(exception: HttpException): Classification {
    const status = exception.getStatus();
    const body = exception.getResponse();

    if (typeof body === 'object' && body !== null) {
      const envelope = (body as { error?: { code?: unknown; details?: unknown } }).error;
      if (envelope !== undefined && isSafeErrorCode(envelope.code)) {
        return { status, code: envelope.code, details: safeDetails(envelope.details) };
      }

      // Nest's built-in `ValidationPipe` output, when `validationExceptionFactory` is somehow not
      // installed. The sentences in `message` are deliberately dropped rather than forwarded.
      if (
        status === HttpStatus.BAD_REQUEST &&
        Array.isArray((body as { message?: unknown }).message)
      ) {
        this.logger.warn(
          'A ValidationPipe rejection arrived without structured details — is ' +
            'validationExceptionFactory still installed in main.ts? Responding without `details`.',
        );
        return { status, code: ERROR_CODE.VALIDATION_FAILED };
      }
    }

    return { status, code: STATUS_CODE_MAP[status] ?? fallbackCodeForStatus(status) };
  }

  // --- output ------------------------------------------------------------------------------

  /**
   * Writes the envelope. The only function in the process that serialises an error to a client.
   *
   * `isSafeErrorCode` is re-checked here rather than trusted from `classify`: this is the last
   * line before the socket, and the check costs a regular-expression match on a path that has
   * already failed.
   */
  private send(response: Response, classification: Classification, traceId: string): void {
    // A handler that streamed part of a response before throwing cannot be given a JSON body;
    // destroying the socket is the only honest outcome and is preferable to Express's
    // "Cannot set headers after they are sent" crash.
    if (response.headersSent) {
      response.end();
      return;
    }

    const code = isSafeErrorCode(classification.code)
      ? classification.code
      : ERROR_CODE.INTERNAL_ERROR;
    const details = safeDetails(classification.details);

    const body: ErrorBody = {
      error: {
        code,
        message: this.messages.get(code),
        ...(details !== undefined && details.length > 0 ? { details } : {}),
        traceId,
      },
    };

    response.status(classification.status).json(body);
  }

  /**
   * The server-side half: everything the response deliberately omits.
   *
   * Levels follow 08-OBSERVABILITY.md §4 — 5xx and unhandled exceptions at `error`; auth
   * failures, permission denials and rate limits at `warn` (*"A permission denial is `warn`, not
   * `info`. One is noise; a hundred in a minute from one account is an attack in progress"*);
   * everything else at `debug`, because a 400 from a mistyped form is not an operational event.
   *
   * The context object passes through {@link redactForLog} — this line is the one place a whole
   * exception object, including a Sequelize error's bind parameters, is written out.
   */
  private log(
    exception: unknown,
    request: Request,
    classification: Classification,
    traceId: string,
  ): void {
    const context = redactForLog({
      traceId,
      status: classification.status,
      code: classification.code,
      method: request.method,
      route: routeOf(request),
      error: exception,
    });
    const line = `${classification.code} ${classification.status} ${request.method} ${routeOf(
      request,
    )} traceId=${traceId}`;

    if (classification.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`${line} ${safeJson(context)}`, stackOf(exception));
      return;
    }
    if (
      classification.status === HttpStatus.UNAUTHORIZED ||
      classification.status === HttpStatus.FORBIDDEN ||
      classification.status === HttpStatus.TOO_MANY_REQUESTS
    ) {
      this.logger.warn(`${line} ${safeJson(context)}`);
      return;
    }
    this.logger.debug(`${line} ${safeJson(context)}`);
  }
}

// --- helpers -------------------------------------------------------------------------------

/**
 * Drops any `details` entry that is not a `{ field, code }` pair of safe shape, and returns
 * `undefined` rather than an empty array when nothing survives — `details` is documented as
 * present on validation failures only.
 */
function safeDetails(details: unknown): readonly ErrorDetail[] | undefined {
  if (!Array.isArray(details)) return undefined;
  const safe = details.filter(isSafeDetail);
  return safe.length > 0 ? safe : undefined;
}

/**
 * A 5xx with no mapping is internal; a 4xx with no mapping is the client's fault but not one we
 * have a name for. Both get a code from the catalogue rather than an invented one.
 */
function fallbackCodeForStatus(status: number): string {
  return status >= HttpStatus.INTERNAL_SERVER_ERROR
    ? ERROR_CODE.INTERNAL_ERROR
    : ERROR_CODE.VALIDATION_FAILED;
}

/** The parameterised route where Express knows it (08-OBSERVABILITY.md §3), else the path. */
export function routeOf(request: Request): string {
  const route = (request as { route?: { path?: unknown } }).route;
  return typeof route?.path === 'string' ? route.path : request.path;
}

/** `name: message` for the log line prefix. Never used in a response. */
function describe(exception: unknown): string {
  if (exception instanceof Error) return `${exception.name}: ${exception.message}`;
  return typeof exception === 'string' ? exception : Object.prototype.toString.call(exception);
}

function stackOf(exception: unknown): string | undefined {
  return exception instanceof Error ? exception.stack : undefined;
}

/**
 * `JSON.stringify` that cannot throw. The log path must survive a payload with a `BigInt` or a
 * `toJSON` that throws; a logger that can crash is a denial of service on the error path.
 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    );
  } catch {
    return '[UNSERIALISABLE]';
  }
}
