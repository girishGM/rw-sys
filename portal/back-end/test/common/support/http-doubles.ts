/**
 * T-014 unit-test support — the HTTP shapes an interceptor and an exception filter are handed by
 * Nest, and the two stores this task writes through.
 *
 * The design choice mirrors T-013's `test/rbac/support/execution-context.ts`: contexts are built
 * around **real decorated controller classes**, so a `Reflector` created in a spec reads
 * `@Audit()` metadata through the same path Nest uses at runtime. Stubbing
 * `Reflector.getAllAndOverride` would test the interceptor's `if` statements while assuming away
 * the question most likely to be wrong — whether the decorator writes the key the interceptor
 * reads.
 *
 * One deliberate difference: `ArgumentsHost` here is built **without** `getHandler`/`getClass`,
 * because that is what Nest really does for an exception filter — `RouterProxy.createProxy`
 * constructs `new ExecutionContextHost([req, res, next])` with no handler reference. A double
 * that offered them would let a filter implementation depend on something that is `undefined` in
 * production.
 */
import type { ArgumentsHost, ExecutionContext, Type } from '@nestjs/common';
import type {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import type { AuditStore, DomainAuditRow, PortalAuditRow } from '@/common/audit/audit.repository';

type ControllerClass = Type<object>;

/** A believable `AuthenticatedUser`, overridable field by field. */
export function actor(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: 42,
    sessionId: '11111111-1111-4111-8111-111111111111',
    role: 'maker',
    countryId: 3,
    tenantId: 7,
    merchantId: null,
    rbacVersion: 1,
    tokenId: '22222222-2222-4222-8222-222222222222',
    mustChangePassword: false,
    ...overrides,
  };
}

/** The subset of an Express request these components read. */
export function requestDouble(
  overrides: Partial<AuthenticatedRequest> & { routePath?: string } = {},
): AuthenticatedRequest {
  const { routePath, ...rest } = overrides;
  const request = {
    method: 'POST',
    path: '/api/v1/things/8821',
    ip: '10.0.0.4',
    params: {},
    headers: {},
    ...rest,
  } as AuthenticatedRequest;
  if (routePath !== undefined) {
    (request as { route?: { path: string } }).route = { path: routePath };
  }
  return request;
}

/** What a spec can assert about the response the filter wrote. */
export interface ResponseDouble {
  statusCode: number | null;
  body: unknown;
  headersSent: boolean;
  ended: boolean;
  status(code: number): ResponseDouble;
  json(payload: unknown): ResponseDouble;
  end(): void;
}

export function responseDouble(headersSent = false): ResponseDouble {
  const response: ResponseDouble = {
    statusCode: null,
    body: undefined,
    headersSent,
    ended: false,
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    json(payload: unknown) {
      response.body = payload;
      return response;
    },
    end() {
      response.ended = true;
    },
  };
  return response;
}

export interface ContextOptions {
  /** Defaults to `'http'`; set to `'rpc'` to exercise the non-HTTP passthrough branches. */
  readonly type?: string;
  /** Becomes `request.authUser`. Omit for an anonymous request. */
  readonly authUser?: AuthenticatedUser;
  readonly request?: Partial<AuthenticatedRequest> & { routePath?: string };
}

/** An `ExecutionContext` for `Controller.prototype[handler]`, as an interceptor sees it. */
export function contextFor(
  controller: ControllerClass,
  handler: string,
  options: ContextOptions = {},
): ExecutionContext {
  const method = (controller.prototype as Record<string, unknown>)[handler];
  if (typeof method !== 'function') {
    throw new Error(`${controller.name} has no handler named "${handler}"`);
  }

  const request = requestDouble(options.request);
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

/**
 * An `ArgumentsHost` as the **exception layer** builds it: request and response, no handler.
 * See the file header for why the omission is deliberate.
 */
export function argumentsHostFor(
  request: AuthenticatedRequest,
  response: ResponseDouble,
  type = 'http',
): ArgumentsHost {
  const unsupported = (member: string) => (): never => {
    throw new Error(`ArgumentsHost.${member}() is not implemented in this test double`);
  };

  return {
    getType: () => type,
    switchToHttp: () => ({
      getRequest: <T>() => request as T,
      getResponse: <T>() => response as T,
      getNext: unsupported('switchToHttp().getNext'),
    }),
    switchToRpc: unsupported('switchToRpc'),
    switchToWs: unsupported('switchToWs'),
    getArgs: unsupported('getArgs'),
    getArgByIndex: unsupported('getArgByIndex'),
  } as unknown as ArgumentsHost;
}

/** An in-memory {@link AuditStore} that records what it was asked to insert. */
export class FakeAuditStore implements AuditStore {
  readonly portalRows: PortalAuditRow[] = [];
  readonly domainRows: DomainAuditRow[] = [];
  /** Set to make the next insert reject, for the "an audit outage must not fail a request" case. */
  failWith: Error | null = null;
  adminUserIdByPortalUser = new Map<number, number>();

  async insertPortalEvent(row: PortalAuditRow): Promise<void> {
    if (this.failWith !== null) throw this.failWith;
    this.portalRows.push(row);
  }

  async insertDomainEvent(row: DomainAuditRow): Promise<void> {
    if (this.failWith !== null) throw this.failWith;
    this.domainRows.push(row);
  }

  async findAdminUserId(portalUserId: number): Promise<number | null> {
    if (this.failWith !== null) throw this.failWith;
    return this.adminUserIdByPortalUser.get(portalUserId) ?? null;
  }
}
