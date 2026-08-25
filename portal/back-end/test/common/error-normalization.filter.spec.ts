/**
 * T-014 — `ErrorNormalizationFilter`: TC-8 through TC-12 and TC-16.
 *
 * ### How TC-12 is tested here
 *
 * > *"Response body scanned for `reward_config`, `SELECT`, `at Object.` → **zero matches on any
 * > error path**"*, and the Definition of Done adds: *"must be run against **every** error path
 * > the module can produce, not a sample."*
 *
 * A sample is what an assertion-per-case suite produces, so the check is inverted: `EVERY_ERROR`
 * below is a table of every category of exception this filter can be handed — `AppError` and each
 * subclass, each pre-built `HttpException` envelope from T-011/T-012/T-013, every Nest built-in,
 * every Sequelize error class, a validation failure, a bare `TypeError`, a thrown string, a
 * thrown object — and one `it.each` runs the forbidden-substring scan across all of them. Adding
 * a new error type to the system means adding a row there, and the scan covers it for free.
 *
 * The forbidden list is broader than the task file's three strings, because the three are
 * examples of three classes of leak (schema, SQL, stack) and a test that matched only them would
 * pass while leaking `portal_user_credentials`, `INSERT INTO` or `/Users/…/src/…`.
 */
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ConnectionError,
  DatabaseError,
  ForeignKeyConstraintError,
  UniqueConstraintError,
  ValidationError as SequelizeValidationError,
} from 'sequelize';
import { AuditService } from '@/common/audit/audit.service';
import { PORTAL_AUDIT_EVENT } from '@/common/audit/audit.constants';
import {
  AppError,
  BusinessRuleError,
  ConflictError,
  ERROR_CODE,
  ErrorNormalizationFilter,
  NotFoundError,
  ValidationFailedError,
} from '@/common/errors';
import { MessageService } from '@/common/messages/message.service';
import type { MessageStore, SystemMessageRow } from '@/common/messages/message.repository';
import { MissingScopeContextError } from '@/common/scope/scope-context';
import { ScopeViolationError, SCOPE_ERROR_CODE } from '@/common/scope/scope.exceptions';
import { PermissionDeniedHttpException } from '@/common/rbac/rbac.exceptions';
import { PERMISSION_DENIED_CODE } from '@/common/rbac/rbac.constants';
import {
  CsrfTokenInvalidHttpException,
  CsrfTokenMissingHttpException,
  RateLimitedHttpException,
  ServiceUnavailableHttpException,
} from '@/common/security/security.exceptions';
import { SECURITY_ERROR_CODE } from '@/common/security/security.constants';
import {
  InvalidCredentialsHttpException,
  NotFoundHttpException,
  PasswordPolicyHttpException,
  SessionInvalidHttpException,
} from '@/modules/auth/auth.exceptions';
import { AUTH_ERROR_CODE } from '@/modules/auth/session.constants';
import {
  FakeAuditStore,
  actor,
  argumentsHostFor,
  requestDouble,
  responseDouble,
  type ResponseDouble,
} from './support/http-doubles';

class FakeMessageStore implements MessageStore {
  async loadAll(): Promise<readonly SystemMessageRow[]> {
    return [
      { key: ERROR_CODE.PERM_DENIED, text: 'You do not have permission to perform this action.' },
      { key: ERROR_CODE.INTERNAL_ERROR, text: 'Something went wrong. Please try again.' },
      { key: ERROR_CODE.NOT_FOUND, text: 'The requested resource could not be found.' },
    ];
  }
}

/** Every category of exception the filter can be handed. See the file header. */
const EVERY_ERROR: ReadonlyArray<readonly [string, unknown]> = [
  ['AppError — NotFoundError', new NotFoundError({ logMessage: 'campaign 8821 not in scope' })],
  ['AppError — ConflictError', new ConflictError(ERROR_CODE.DUPLICATE_RESOURCE)],
  ['AppError — BusinessRuleError', new BusinessRuleError()],
  [
    'AppError — ValidationFailedError',
    new ValidationFailedError([{ field: 'startDate', code: 'DATE_IN_PAST' }]),
  ],
  ['T-011 — InvalidCredentialsHttpException', new InvalidCredentialsHttpException()],
  ['T-011 — SessionInvalidHttpException', new SessionInvalidHttpException()],
  ['T-011 — PasswordPolicyHttpException', new PasswordPolicyHttpException(['TOO_SHORT'])],
  ['T-011 — NotFoundHttpException', new NotFoundHttpException()],
  ['T-012 — CsrfTokenMissingHttpException', new CsrfTokenMissingHttpException()],
  ['T-012 — CsrfTokenInvalidHttpException', new CsrfTokenInvalidHttpException()],
  ['T-012 — RateLimitedHttpException', new RateLimitedHttpException(30)],
  ['T-012 — ServiceUnavailableHttpException', new ServiceUnavailableHttpException()],
  ['T-013 — PermissionDeniedHttpException', new PermissionDeniedHttpException()],
  ['T-013 — ScopeViolationError', new ScopeViolationError()],
  ['T-013 — MissingScopeContextError', new MissingScopeContextError('findAll(TenantCampaign)')],
  ['Nest — NotFoundException', new NotFoundException()],
  ['Nest — ForbiddenException', new ForbiddenException()],
  ['Nest — InternalServerErrorException', new InternalServerErrorException()],
  ['Nest — ServiceUnavailableException', new ServiceUnavailableException()],
  [
    'Nest — BadRequestException with the default ValidationPipe payload',
    new BadRequestException({
      statusCode: 400,
      message: ['email must be an email', 'property tenantId should not exist'],
      error: 'Bad Request',
    }),
  ],
  ['Nest — HttpException with a string body', new HttpException('I am a teapot', 418)],
  [
    'Sequelize — UniqueConstraintError',
    new UniqueConstraintError({
      message:
        'duplicate key value violates unique constraint "uq_tc_tenant_code" on reward_config.tenant_campaigns',
      errors: [],
      fields: { campaign_code: 'T042' },
    }),
  ],
  [
    'Sequelize — ForeignKeyConstraintError',
    new ForeignKeyConstraintError({
      message:
        'insert or update on table "campaign_audit_trail" violates foreign key constraint "fk_cat_performed_by"',
      table: 'reward_config.campaign_audit_trail',
      fields: { performed_by: '42' },
    }),
  ],
  [
    'Sequelize — DatabaseError',
    new DatabaseError(
      Object.assign(new Error('column "budget_amont" does not exist'), {
        sql: 'SELECT "id", "budget_amont" FROM "reward_config"."tenant_campaigns" AS "TenantCampaign"',
        parameters: { tenantId: 7 },
      }),
    ),
  ],
  ['Sequelize — ConnectionError', new ConnectionError(new Error('ECONNREFUSED 127.0.0.1:5432'))],
  [
    'Sequelize — ValidationError',
    new SequelizeValidationError('notNull Violation: portal_users.email cannot be null', []),
  ],
  [
    'a bare TypeError from a service',
    new TypeError("Cannot read properties of undefined (reading 'id')"),
  ],
  ['a thrown string', 'something went wrong in reward_config.tenant_campaigns'],
  ['a thrown plain object', { sql: 'SELECT * FROM reward_config.tenants', code: '42P01' }],
  ['null', null],
];

/** Substrings that must never appear in a response body, by category of leak. */
const FORBIDDEN_IN_BODY = [
  // schema
  'reward_config',
  'reward_portal',
  'portal_users',
  'campaign_audit_trail',
  'uq_tc_tenant_code',
  'fk_cat_performed_by',
  // SQL
  'SELECT',
  'INSERT INTO',
  'UPDATE ',
  'violates foreign key',
  'notNull Violation',
  // stacks and paths
  'at Object.',
  'at Function.',
  '/src/',
  '.ts:',
  'node_modules',
  // internal prose
  'must be an email',
  'should not exist',
  'ECONNREFUSED',
  'Cannot read properties',
];

describe('ErrorNormalizationFilter', () => {
  let filter: ErrorNormalizationFilter;
  let messages: MessageService;
  let auditStore: FakeAuditStore;
  let response: ResponseDouble;
  let logs: { error: jest.SpyInstance; warn: jest.SpyInstance; debug: jest.SpyInstance };

  beforeEach(async () => {
    logs = {
      error: jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
      warn: jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
      debug: jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined),
    };
    messages = new MessageService(new FakeMessageStore());
    await messages.onModuleInit();
    auditStore = new FakeAuditStore();
    filter = new ErrorNormalizationFilter(messages, new AuditService(auditStore));
    response = responseDouble();
  });

  afterEach(() => {
    messages.onModuleDestroy();
    jest.restoreAllMocks();
  });

  /** Runs the filter and waits for the audit write it awaits before responding. */
  async function handle(
    exception: unknown,
    request = requestDouble(),
    target: ResponseDouble = response,
  ): Promise<{ status: number | null; body: { error: Record<string, unknown> } }> {
    filter.catch(exception, argumentsHostFor(request, target));
    // The filter writes the audit row, then responds. Both are microtask-ordered.
    await new Promise((resolve) => setImmediate(resolve));
    return {
      status: target.statusCode,
      body: target.body as { error: Record<string, unknown> },
    };
  }

  // --- TC-12, over every error path ---------------------------------------------------------

  describe('TC-12 — no internal detail in any response body', () => {
    it.each(EVERY_ERROR)('%s leaks nothing', async (_name, exception) => {
      const { body } = await handle(exception);
      const serialised = JSON.stringify(body);

      for (const forbidden of FORBIDDEN_IN_BODY) {
        expect(serialised).not.toContain(forbidden);
      }
    });

    it.each(EVERY_ERROR)(
      '%s produces exactly the documented envelope',
      async (_name, exception) => {
        const { body, status } = await handle(exception);

        expect(Object.keys(body)).toEqual(['error']);
        expect(Object.keys(body.error).sort()).toEqual(
          expect.arrayContaining(['code', 'message', 'traceId']),
        );
        for (const key of Object.keys(body.error)) {
          expect(['code', 'message', 'details', 'traceId']).toContain(key);
        }
        expect(typeof body.error.code).toBe('string');
        expect(body.error.code).toMatch(/^[A-Z][A-Z0-9_]{1,59}$/);
        expect(typeof body.error.traceId).toBe('string');
        expect(status).toBeGreaterThanOrEqual(400);
      },
    );
  });

  // --- pass-through of the envelopes earlier tasks already build ----------------------------

  describe('the codes T-011/T-012/T-013 already chose survive unchanged', () => {
    it.each([
      [new InvalidCredentialsHttpException(), 401, AUTH_ERROR_CODE.INVALID_CREDENTIALS],
      [new SessionInvalidHttpException(), 401, AUTH_ERROR_CODE.SESSION_INVALID],
      [new NotFoundHttpException(), 404, AUTH_ERROR_CODE.NOT_FOUND],
      [new PermissionDeniedHttpException(), 403, PERMISSION_DENIED_CODE],
      [new ScopeViolationError(), 404, SCOPE_ERROR_CODE.NOT_FOUND],
      [new CsrfTokenMissingHttpException(), 403, SECURITY_ERROR_CODE.CSRF_TOKEN_MISSING],
      [new RateLimitedHttpException(30), 429, SECURITY_ERROR_CODE.RATE_LIMITED],
      [new ServiceUnavailableHttpException(), 503, SECURITY_ERROR_CODE.SERVICE_UNAVAILABLE],
    ])('%#: keeps the status and the code', async (exception, status, code) => {
      const result = await handle(exception);

      expect(result.status).toBe(status);
      expect(result.body.error.code).toBe(code);
    });

    it('adds the catalogue text and a traceId, and nothing else', async () => {
      const { body } = await handle(new PermissionDeniedHttpException());

      expect(body.error).toEqual({
        code: 'PERM_DENIED',
        message: 'You do not have permission to perform this action.',
        traceId: expect.any(String),
      });
    });

    it('keeps a T-011 details array (password policy violations)', async () => {
      const { body } = await handle(new PasswordPolicyHttpException(['TOO_SHORT', 'NO_DIGIT']));

      expect(body.error.details).toEqual([
        { field: 'newPassword', code: 'TOO_SHORT' },
        { field: 'newPassword', code: 'NO_DIGIT' },
      ]);
    });

    it('the three NOT_FOUND codes are one code — 02-SECURITY.md §5.1', () => {
      expect(ERROR_CODE.NOT_FOUND).toBe(SCOPE_ERROR_CODE.NOT_FOUND);
      expect(ERROR_CODE.NOT_FOUND).toBe(AUTH_ERROR_CODE.NOT_FOUND);
      expect(ERROR_CODE.PERM_DENIED).toBe(PERMISSION_DENIED_CODE);
    });
  });

  // --- TC-8 -----------------------------------------------------------------------------------

  describe('TC-8 — an unhandled TypeError in a service', () => {
    it('answers 500 INTERNAL_ERROR with a traceId and no stack', async () => {
      const { status, body } = await handle(
        new TypeError("Cannot read properties of undefined (reading 'tenantId')"),
      );

      expect(status).toBe(500);
      expect(body.error.code).toBe(ERROR_CODE.INTERNAL_ERROR);
      expect(body.error.message).toBe('Something went wrong. Please try again.');
      expect(body.error.traceId).toEqual(expect.any(String));
      expect(JSON.stringify(body)).not.toContain('Cannot read properties');
    });

    it('sends the real error and its stack to the server log only', async () => {
      const boom = new TypeError('boom');
      await handle(boom);

      expect(logs.error).toHaveBeenCalledWith(
        expect.stringContaining('INTERNAL_ERROR 500'),
        boom.stack,
      );
    });
  });

  // --- TC-9 / TC-10 ---------------------------------------------------------------------------

  describe('TC-9 — a Sequelize UniqueConstraintError', () => {
    it('answers 409 with a business code, not the constraint name', async () => {
      const [, exception] = EVERY_ERROR.find(([name]) =>
        name.includes('UniqueConstraintError'),
      ) as [string, unknown];

      const { status, body } = await handle(exception);

      expect(status).toBe(409);
      expect(body.error.code).toBe(ERROR_CODE.DUPLICATE_RESOURCE);
      expect(JSON.stringify(body)).not.toContain('uq_tc_tenant_code');
      expect(JSON.stringify(body)).not.toContain('campaign_code');
    });

    it('maps a foreign-key violation to its own code, still without the constraint name', async () => {
      const [, exception] = EVERY_ERROR.find(([name]) =>
        name.includes('ForeignKeyConstraintError'),
      ) as [string, unknown];

      const { status, body } = await handle(exception);

      expect(status).toBe(409);
      expect(body.error.code).toBe(ERROR_CODE.RELATED_RESOURCE_MISSING);
    });
  });

  describe('TC-10 — any other Sequelize error', () => {
    it.each(['DatabaseError', 'ConnectionError', 'Sequelize — ValidationError'])(
      '%s becomes a generic 500 with no table or column name',
      async (name) => {
        const [, exception] = EVERY_ERROR.find(([label]) => label.includes(name)) as [
          string,
          unknown,
        ];

        const { status, body } = await handle(exception);

        expect(status).toBe(500);
        expect(body.error.code).toBe(ERROR_CODE.INTERNAL_ERROR);
        expect(JSON.stringify(body)).not.toMatch(/budget_amont|tenant_campaigns|email/);
      },
    );
  });

  // --- TC-11 -----------------------------------------------------------------------------------

  describe('TC-11 — a validation failure', () => {
    it('answers 400 with a details array of {field, code} and no prose', async () => {
      const { status, body } = await handle(
        new ValidationFailedError([
          { field: 'startDate', code: 'DATE_IN_PAST' },
          { field: 'policies[0].unitCode', code: 'IS_STRING' },
        ]),
      );

      expect(status).toBe(400);
      expect(body.error.code).toBe(ERROR_CODE.VALIDATION_FAILED);
      expect(body.error.details).toEqual([
        { field: 'startDate', code: 'DATE_IN_PAST' },
        { field: 'policies[0].unitCode', code: 'IS_STRING' },
      ]);
    });

    it('drops Nest’s own sentence array when the exceptionFactory is not installed', async () => {
      const [, exception] = EVERY_ERROR.find(([name]) =>
        name.includes('default ValidationPipe payload'),
      ) as [string, unknown];

      const { status, body } = await handle(exception);

      expect(status).toBe(400);
      expect(body.error.code).toBe(ERROR_CODE.VALIDATION_FAILED);
      expect(body.error.details).toBeUndefined();
      expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining('validationExceptionFactory'));
    });

    it('filters out a details entry that is not a safe {field, code} pair', async () => {
      // A hostile or careless thrower. `details` is echoed to the client, so it is validated on
      // the way out, not trusted on the way in.
      const unsafe = new HttpException(
        {
          error: {
            code: 'VALIDATION_FAILED',
            details: [
              { field: 'ok', code: 'REQUIRED' },
              { field: 'SELECT * FROM reward_config.tenants', code: 'x' },
              { field: 'name', code: 'lowercase is not a code' },
              'not an object',
              { field: 'name' },
            ],
          },
        },
        400,
      );

      const { body } = await handle(unsafe);

      expect(body.error.details).toEqual([{ field: 'ok', code: 'REQUIRED' }]);
    });
  });

  // --- TC-16 -----------------------------------------------------------------------------------

  describe('TC-16 — the traceId', () => {
    it('is the same value in the response and in the server log', async () => {
      const { body } = await handle(new TypeError('boom'));
      const logged = logs.error.mock.calls[0][0] as string;

      expect(logged).toContain(`traceId=${String(body.error.traceId)}`);
    });

    it('adopts a well-formed client correlation id', async () => {
      const request = requestDouble({ headers: { 'x-correlation-id': '01J8F3K9QP2M7N' } });
      const { body } = await handle(new NotFoundError(), request);

      expect(body.error.traceId).toBe('01J8F3K9QP2M7N');
    });

    it('ignores a malformed or injected correlation id and generates its own', async () => {
      const request = requestDouble({
        headers: { 'x-correlation-id': 'bad id\nfake log line: user 1 logged in' },
      });
      const { body } = await handle(new NotFoundError(), request);

      expect(body.error.traceId).not.toContain('\n');
      expect(body.error.traceId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    });

    it('is stable across two failures on the same request object', async () => {
      const request = requestDouble();
      const first = await handle(new NotFoundError(), request);
      const second = await handle(new NotFoundError(), request, responseDouble());

      expect(second.body.error.traceId).toBe(first.body.error.traceId);
    });
  });

  // --- audit hand-off (TC-2 / TC-3 through the filter) ---------------------------------------

  describe('security failures are audited from here', () => {
    it('writes permission_denied and only then answers the client', async () => {
      const request = requestDouble({
        routePath: '/api/v1/campaigns/:id/submit',
        authUser: actor({ userId: 42, role: 'merchant' }),
      });

      const { status } = await handle(new PermissionDeniedHttpException(), request);

      expect(status).toBe(403);
      expect(auditStore.portalRows).toHaveLength(1);
      expect(auditStore.portalRows[0]).toMatchObject({
        eventType: PORTAL_AUDIT_EVENT.PERMISSION_DENIED,
        actorId: 42,
        targetId: '/api/v1/campaigns/:id/submit',
      });
    });

    it('writes login_failure for a rejected sign-in', async () => {
      await handle(
        new InvalidCredentialsHttpException(),
        requestDouble({ routePath: '/api/v1/auth/login', body: { password: 'hunter2' } }),
      );

      expect(auditStore.portalRows[0].eventType).toBe(PORTAL_AUDIT_EVENT.LOGIN_FAILURE);
      expect(JSON.stringify(auditStore.portalRows[0])).not.toContain('hunter2');
    });

    it('still answers the client when the audit write fails', async () => {
      auditStore.failWith = new Error('permission denied for table portal_audit_log');

      const { status, body } = await handle(new PermissionDeniedHttpException());

      expect(status).toBe(403);
      expect(body.error.code).toBe('PERM_DENIED');
    });

    it('writes no row for an ordinary 404', async () => {
      await handle(new NotFoundError());
      expect(auditStore.portalRows).toHaveLength(0);
    });
  });

  // --- log levels (08-OBSERVABILITY.md §4) ----------------------------------------------------

  describe('log levels', () => {
    it('logs a 5xx at error', async () => {
      await handle(new TypeError('boom'));
      expect(logs.error).toHaveBeenCalled();
    });

    it('logs a permission denial at warn — a hundred a minute is an attack in progress', async () => {
      await handle(new PermissionDeniedHttpException());
      expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining('PERM_DENIED 403'));
    });

    it.each([
      ['401', new SessionInvalidHttpException()],
      ['429', new RateLimitedHttpException(30)],
    ])('logs %s at warn', async (_name, exception) => {
      await handle(exception);
      expect(logs.warn).toHaveBeenCalled();
    });

    it('logs an ordinary validation failure at debug, not warn', async () => {
      await handle(new ValidationFailedError([{ field: 'name', code: 'REQUIRED' }]));

      expect(logs.debug).toHaveBeenCalledWith(expect.stringContaining('VALIDATION_FAILED 400'));
      // `MessageService` may warn about an unseeded key; what must not happen is the *request*
      // being logged at warn, which is the level operators alert on.
      expect(logs.warn).not.toHaveBeenCalledWith(expect.stringContaining('VALIDATION_FAILED 400'));
    });

    it('never logs the request body — verification step 5, "grep the log for the password"', async () => {
      // The log context is built from the method, route, status and the exception. The body is
      // not read at all, so a submitted password cannot reach the log even if the redaction list
      // were incomplete.
      await handle(
        new InvalidCredentialsHttpException(),
        requestDouble({
          routePath: '/api/v1/auth/login',
          body: { email: 'victim@example.com', password: 'hunter2-correct-horse' },
        }),
      );

      const logged = logs.warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('AUTH_INVALID_CREDENTIALS 401');
      expect(logged).not.toContain('hunter2-correct-horse');
      expect(logged).not.toContain('victim@example.com');
    });

    it('redacts the logged payload', async () => {
      const error = Object.assign(new Error('insert failed'), { password_hash: '$argon2id$…' });
      await handle(error);

      const logged = logs.error.mock.calls[0][0] as string;
      expect(logged).toContain('[REDACTED]');
      expect(logged).not.toContain('argon2id');
    });

    it('survives a BigInt in the log payload', async () => {
      const withBigInt = Object.assign(new Error('boom'), { big: BigInt(9) });
      await expect(handle(withBigInt)).resolves.toBeDefined();
    });

    it('survives a payload that cannot be serialised at all', async () => {
      // A `toJSON` that throws is copied through the redactor as a function and then invoked by
      // `JSON.stringify`. The log line degrades; the response does not.
      const hostile = Object.assign(new Error('boom'), {
        toJSON: () => {
          throw new Error('nope');
        },
      });

      const { status, body } = await handle(hostile);

      expect(status).toBe(500);
      expect(body.error.code).toBe(ERROR_CODE.INTERNAL_ERROR);
      expect(logs.error.mock.calls[0][0]).toContain('[UNSERIALISABLE]');
    });
  });

  // --- edge cases -------------------------------------------------------------------------------

  describe('edge cases', () => {
    it('logs, rather than crashing the process, when the response itself cannot be written', async () => {
      // An unhandled rejection here would terminate the process under Node's default
      // `--unhandled-rejections=throw`: one client disconnecting mid-write would take the server
      // down. The failure has to end at a log line.
      const broken = responseDouble();
      broken.json = () => {
        throw new Error('socket closed by peer');
      };

      await expect(handle(new TypeError('boom'), requestDouble(), broken)).resolves.toBeDefined();
      expect(logs.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to write the error response'),
        expect.any(String),
      );
    });

    it('ends the response instead of crashing when headers are already sent', async () => {
      const streamed = responseDouble(true);
      await handle(new TypeError('boom'), requestDouble(), streamed);

      expect(streamed.ended).toBe(true);
      expect(streamed.body).toBeUndefined();
    });

    it('logs and returns for a non-HTTP context rather than writing to a socket', () => {
      const host = argumentsHostFor(requestDouble(), response, 'rpc');

      expect(() => filter.catch(new Error('grpc handler failed'), host)).not.toThrow();
      expect(response.statusCode).toBeNull();
      expect(logs.error).toHaveBeenCalledWith(
        expect.stringContaining('outside an HTTP context'),
        expect.any(String),
      );
    });

    it.each([
      ['a thrown string', 'plain string'],
      ['a thrown number', 42],
      ['a thrown symbol-ish object', { toString: () => 'nope' }],
    ])('logs %s outside HTTP without a stack', (_name, thrown) => {
      const host = argumentsHostFor(requestDouble(), response, 'rpc');
      expect(() => filter.catch(thrown, host)).not.toThrow();
    });

    it('falls back to INTERNAL_ERROR when a service throws an AppError with an unsafe code', async () => {
      // The last line before the socket re-checks the code rather than trusting `classify`.
      // A Wave 3 service that wrote `new ConflictError(someConstraintName)` lands here.
      const { status, body } = await handle(new AppError('uq_tc_tenant_code', 409));

      expect(status).toBe(409);
      expect(body.error.code).toBe(ERROR_CODE.INTERNAL_ERROR);
      expect(JSON.stringify(body)).not.toContain('uq_tc_tenant_code');
    });

    it('omits details entirely when every entry is unsafe', async () => {
      const { body } = await handle(
        new HttpException(
          { error: { code: 'VALIDATION_FAILED', details: [{ field: 'x y', code: 'nope' }] } },
          400,
        ),
      );

      expect(body.error.details).toBeUndefined();
      expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'traceId']);
    });

    it('falls back to INTERNAL_ERROR when an HttpException carries an unsafe code', async () => {
      const unsafe = new HttpException({ error: { code: 'select * from tenants' } }, 500);
      const { body } = await handle(unsafe);

      expect(body.error.code).toBe(ERROR_CODE.INTERNAL_ERROR);
    });

    it('maps an unmapped 4xx status to a catalogue code rather than inventing one', async () => {
      const { status, body } = await handle(new HttpException('I am a teapot', 418));

      expect(status).toBe(418);
      expect(body.error.code).toBe(ERROR_CODE.VALIDATION_FAILED);
    });

    it('maps an unmapped 5xx status to INTERNAL_ERROR', async () => {
      const { status, body } = await handle(new HttpException({ nope: true }, 507));

      expect(status).toBe(507);
      expect(body.error.code).toBe(ERROR_CODE.INTERNAL_ERROR);
    });

    it('falls back to the key when the catalogue has no row for the code', async () => {
      const { body } = await handle(new BusinessRuleError());

      expect(body.error.code).toBe(ERROR_CODE.BUSINESS_RULE_VIOLATION);
      expect(body.error.message).toBe(ERROR_CODE.BUSINESS_RULE_VIOLATION);
    });
  });
});
