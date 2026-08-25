/**
 * T-013 — `assertRole`, the third enforcement layer (implementation note 7, TC-19).
 *
 * TC-19 in full — *"`maker` granted `rule:create` by editing the DB, then calls `POST /rules` →
 * 403"* — needs an HTTP request and is asserted in `rbac.e2e-spec.ts`. What is proved here is the
 * property that makes it work: this function's answer does not depend on the permission table,
 * on a cache, or on anything else that a row can change.
 */
import { Logger } from '@nestjs/common';
import { PermissionDeniedHttpException, assertRole } from '@/common/rbac';

const superAdmin = { userId: 1, role: 'super_admin' } as const;
const maker = { userId: 2, role: 'maker' } as const;
const checker = { userId: 3, role: 'checker' } as const;

describe('assertRole', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    // `assertRole`'s logger is module-scoped and deliberately not exported — the function takes
    // no collaborators at all, which is the property TC-19 depends on. Patching `Logger.prototype`
    // is therefore how the warning is both silenced and asserted.
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns silently for an allowed role', () => {
    expect(() => assertRole(superAdmin, 'super_admin')).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts any of several allowed roles', () => {
    expect(() => assertRole(checker, 'super_admin', 'checker')).not.toThrow();
  });

  it('throws 403 PERM_DENIED for a role that is not allowed', () => {
    let thrown: PermissionDeniedHttpException | undefined;
    try {
      assertRole(maker, 'super_admin');
    } catch (error) {
      thrown = error as PermissionDeniedHttpException;
    }

    expect(thrown).toBeInstanceOf(PermissionDeniedHttpException);
    expect(thrown?.getStatus()).toBe(403);
    expect(thrown?.getResponse()).toEqual({ error: { code: 'PERM_DENIED' } });
  });

  it('warns, because reaching it means both guard layers already passed', () => {
    expect(() => assertRole(maker, 'super_admin')).toThrow();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Service-layer role assertion failed'),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the table is wrong'));
  });

  it('names the user and the required roles in the log but not in the response', () => {
    let thrown: PermissionDeniedHttpException | undefined;
    try {
      assertRole(maker, 'super_admin');
    } catch (error) {
      thrown = error as PermissionDeniedHttpException;
    }

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('user 2'));
    expect(JSON.stringify(thrown?.getResponse())).not.toContain('2');
    expect(JSON.stringify(thrown?.getResponse())).not.toContain('super_admin');
  });

  it('rejects an empty allow-list as a programming error, not as a denial', () => {
    // An empty list denies everyone, which would present as "this endpoint is broken for Super
    // Admin too" — a symptom nobody traces back to a missing argument.
    expect(() => assertRole(superAdmin)).toThrow(/requires at least one allowed role/);
  });

  it('is unaffected by anything in the permission table (the whole point)', () => {
    // There is nothing to stub: this function takes no store, no cache and no reflector. The
    // absence of a collaborator *is* the guarantee TC-19 asks for, and this test documents it.
    expect(assertRole.length).toBe(1); // (actor, ...allowed) — the rest parameter is not counted
    expect(() => assertRole(maker, 'super_admin')).toThrow(PermissionDeniedHttpException);
  });
});
