/**
 * T-013 unit-test support — an `ExecutionContext` double backed by **real decorator metadata**.
 *
 * The important design choice: the specs declare genuine `@Roles(...)` / `@RequirePermission(...)`
 * / `@Public()` controller classes and this helper hands the guards a context whose
 * `getHandler()` and `getClass()` return that real method and that real class. A `Reflector`
 * created here therefore reads metadata through exactly the path Nest uses at runtime.
 *
 * The alternative — stubbing `Reflector.getAllAndOverride` to return a canned array — would test
 * the guards' `if` statements while assuming away the part most likely to be wrong: whether the
 * decorator writes the key the guard reads, and whether handler-level metadata really overrides
 * class-level metadata. Those are the bugs a metadata bug actually is.
 */
import type { ExecutionContext, Type } from '@nestjs/common';
import type {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';

/**
 * Nest's own `Type<T>` — `new (...args: any[]) => T` — which is exactly what `getClass()` returns
 * and exactly what a decorated controller class is. Reusing it rather than declaring a local
 * constructor type keeps this file free of `any` (R8).
 */
type ControllerClass = Type<object>;

export interface ContextOptions {
  /** Defaults to `'http'`; set to `'rpc'`/`'ws'` to exercise the non-HTTP passthrough branch. */
  readonly type?: string;
  /** Becomes `request.authUser`. Omit for an anonymous request. */
  readonly authUser?: AuthenticatedUser;
  /** Extra request properties, if a spec needs them. */
  readonly request?: Partial<AuthenticatedRequest>;
}

/**
 * Builds an `ExecutionContext` for `Controller.prototype[handler]`.
 *
 * Only the four members the guards and the interceptor actually call are implemented; the rest
 * throw, so a future guard that reaches for `switchToRpc()` fails loudly in the test rather than
 * silently receiving `undefined`.
 */
export function contextFor(
  controller: ControllerClass,
  handler: string,
  options: ContextOptions = {},
): ExecutionContext {
  const method = (controller.prototype as Record<string, unknown>)[handler];
  if (typeof method !== 'function') {
    throw new Error(`${controller.name} has no handler named "${handler}"`);
  }

  const request = { ...options.request } as AuthenticatedRequest;
  if (options.authUser !== undefined) request.authUser = options.authUser;

  const unsupported = (member: string) => (): never => {
    throw new Error(`ExecutionContext.${member}() is not implemented in this test double`);
  };

  return {
    getType: () => options.type ?? 'http',
    getClass: () => controller,
    getHandler: () => method,
    switchToHttp: () => ({
      getRequest: <T>() => request as T,
      getResponse: unsupported('switchToHttp().getResponse'),
      getNext: unsupported('switchToHttp().getNext'),
    }),
    switchToRpc: unsupported('switchToRpc'),
    switchToWs: unsupported('switchToWs'),
    getArgs: unsupported('getArgs'),
    getArgByIndex: unsupported('getArgByIndex'),
  } as unknown as ExecutionContext;
}

/** A believable `AuthenticatedUser`, overridable field by field. */
export function actor(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: 1,
    sessionId: '11111111-1111-4111-8111-111111111111',
    role: 'maker',
    countryId: 1,
    tenantId: 7,
    merchantId: null,
    rbacVersion: 1,
    tokenId: '22222222-2222-4222-8222-222222222222',
    mustChangePassword: false,
    ...overrides,
  };
}
