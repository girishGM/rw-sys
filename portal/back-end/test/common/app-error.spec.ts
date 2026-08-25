/**
 * T-014 — `AppError` and the two output validators the filter's last line depends on.
 *
 * The validators are the mechanical half of TC-12: rather than trusting every thrower to supply
 * a safe code, `ErrorNormalizationFilter` checks. So what a *hostile or careless* value does here
 * is the interesting case, not what a well-formed one does.
 */
import * as auditBarrel from '@/common/audit';
import * as messagesBarrel from '@/common/messages';
import {
  AppError,
  BusinessRuleError,
  ConflictError,
  ERROR_CODE,
  NotFoundError,
  SAFE_ERROR_CODE_PATTERN,
  ValidationFailedError,
  isAppError,
  isSafeDetail,
  isSafeErrorCode,
} from '@/common/errors';

describe('AppError', () => {
  it('carries the code and status, and names itself after its subclass for the log', () => {
    const error = new NotFoundError();

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(ERROR_CODE.NOT_FOUND);
    expect(error.status).toBe(404);
    expect(error.name).toBe('NotFoundError');
  });

  it('defaults its message to code + status — never a sentence that could leak', () => {
    expect(new ConflictError().message).toBe(`${ERROR_CODE.CONFLICT} (409)`);
  });

  it('keeps a developer-facing logMessage off the wire but on the Error', () => {
    const error = new NotFoundError({ logMessage: 'campaign 8821 belongs to tenant 12' });

    // The filter never reads `.message`; `error-normalization.filter.spec.ts` proves that for
    // every error type. Here we only assert the sentence is where the author put it.
    expect(error.message).toBe('campaign 8821 belongs to tenant 12');
  });

  it('attaches a cause non-enumerably, so it cannot be serialised into a body by accident', () => {
    const cause = new Error('ECONNREFUSED');
    const error = new BusinessRuleError(ERROR_CODE.BUSINESS_RULE_VIOLATION, { cause });

    expect((error as { cause?: unknown }).cause).toBe(cause);
    expect(Object.keys(error)).not.toContain('cause');
    expect(JSON.stringify(error)).not.toContain('ECONNREFUSED');
  });

  it('carries details and logContext when given them', () => {
    const error = new ValidationFailedError([{ field: 'name', code: 'REQUIRED' }], {
      logContext: { fields: ['name'] },
    });

    expect(error.details).toEqual([{ field: 'name', code: 'REQUIRED' }]);
    expect(error.logContext).toEqual({ fields: ['name'] });
    expect(error.status).toBe(400);
  });

  it('isAppError distinguishes it from every other throwable', () => {
    expect(isAppError(new NotFoundError())).toBe(true);
    expect(isAppError(new AppError('X_CODE', 400))).toBe(true);
    expect(isAppError(new Error('boom'))).toBe(false);
    expect(isAppError('boom')).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});

describe('isSafeErrorCode', () => {
  it.each(['PERM_DENIED', 'NOT_FOUND', 'AUTH_INVALID_CREDENTIALS', 'X1'])('accepts %s', (code) => {
    expect(isSafeErrorCode(code)).toBe(true);
  });

  it.each([
    ['a constraint name', 'uq_tc_tenant_code'],
    ['SQL', 'SELECT * FROM reward_config.tenants'],
    ['a stack frame', 'at Object.<anonymous> (/src/app.ts:12:5)'],
    ['a file path', '/Users/x/src/common/errors/app-error.ts'],
    ['a sentence', 'You do not have permission'],
    ['lower case', 'perm_denied'],
    ['a single character', 'X'],
    ['too long', `X${'A'.repeat(60)}`],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', { code: 'PERM_DENIED' }],
  ])('rejects %s', (_name, code) => {
    expect(isSafeErrorCode(code)).toBe(false);
  });

  it('is the pattern the filter documents', () => {
    expect(SAFE_ERROR_CODE_PATTERN.source).toBe('^[A-Z][A-Z0-9_]{1,59}$');
  });
});

describe('the barrels a Wave 3 task imports', () => {
  it('@/common/audit exports the decorator, the service and the two column vocabularies', () => {
    expect(typeof auditBarrel.Audit).toBe('function');
    expect(typeof auditBarrel.AuditService).toBe('function');
    expect(auditBarrel.CAMPAIGN_AUDIT_ACTION.UPDATED).toBe('updated');
    expect(auditBarrel.CAMPAIGN_AUDIT_ENTITY_TYPE.CAMPAIGN).toBe('campaign');
    expect(auditBarrel.AuditContext.current()).toBeUndefined();
  });

  it('@/common/messages exports the service and its store token', () => {
    expect(typeof messagesBarrel.MessageService).toBe('function');
    expect(typeof messagesBarrel.MESSAGE_STORE).toBe('symbol');
  });

  it('neither barrel re-exports its module — importing one must not boot ConfigModule', () => {
    // See the barrels' own headers: `RbacModule`'s barrel documents why. A unit test that
    // imported a module would run `NestConfigModule.forRoot({ validate })` and could
    // `process.exit(1)` on an incomplete environment, killing the worker with no failing test.
    expect('AuditModule' in auditBarrel).toBe(false);
    expect('MessagesModule' in messagesBarrel).toBe(false);
  });
});

describe('isSafeDetail', () => {
  it('accepts a well-formed {field, code}, including an indexed path', () => {
    expect(isSafeDetail({ field: 'startDate', code: 'DATE_IN_PAST' })).toBe(true);
    expect(isSafeDetail({ field: 'policies[0].unitCode', code: 'IS_STRING' })).toBe(true);
  });

  it.each([
    ['a missing code', { field: 'name' }],
    ['a missing field', { code: 'REQUIRED' }],
    ['an unsafe code', { field: 'name', code: 'lower case' }],
    ['an unsafe field', { field: 'SELECT * FROM x', code: 'REQUIRED' }],
    ['a field with a space', { field: 'first name', code: 'REQUIRED' }],
    ['a non-object', 'name'],
    ['null', null],
    ['a number field', { field: 7, code: 'REQUIRED' }],
  ])('rejects %s', (_name, detail) => {
    expect(isSafeDetail(detail)).toBe(false);
  });
});
