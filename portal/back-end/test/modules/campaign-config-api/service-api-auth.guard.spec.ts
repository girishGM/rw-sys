/**
 * T-INT-010 — `ServiceApiAuthGuard` in isolation. Evidences TC-7, TC-8 and TC-9's negative
 * shape (the e2e suite proves the same three over real HTTP, against the real
 * `grpc_service_grants` table — see `test/e2e/campaign-config-api.e2e-spec.ts`).
 */
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  REJECTED_PORTAL_HEADERS,
  SERVICE_IDENTITY_HEADER,
  ServiceApiAuthGuard,
  type ServiceApiRequest,
} from '@/modules/campaign-config-api/service-api-auth.guard';
import { MutualTlsRequiredError } from '@/grpc/grpc.errors';
import { ServiceScopeGuard, type ResolvedServiceIdentity } from '@/grpc/service-scope.guard';

const TOKEN = 'unit-test-shared-secret';
const IDENTITY = 'txn-runtime.internal';

function contextFor(headers: Record<string, string | string[] | undefined>): {
  context: ExecutionContext;
  request: ServiceApiRequest;
} {
  const request = { headers } as ServiceApiRequest;
  const context = {
    switchToHttp: () => ({ getRequest: <T>() => request as T }),
  } as unknown as ExecutionContext;
  return { context, request };
}

function fakeConfig(token: string | undefined): ConfigService<never, true> {
  return { get: () => token } as unknown as ConfigService<never, true>;
}

function guardWith(
  token: string | undefined,
  scopeGuard: Pick<ServiceScopeGuard, 'resolve'>,
): ServiceApiAuthGuard {
  return new ServiceApiAuthGuard(fakeConfig(token), scopeGuard as ServiceScopeGuard);
}

const VALID_HEADERS = {
  authorization: `Bearer ${TOKEN}`,
  [SERVICE_IDENTITY_HEADER]: IDENTITY,
};

const resolved: ResolvedServiceIdentity = {
  identity: IDENTITY,
  grants: [
    {
      id: 1,
      serviceIdentity: IDENTITY,
      tenantId: null,
      allowedSections: ['BASIC'],
      status: 'active',
      createdBy: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ],
};

describe('ServiceApiAuthGuard', () => {
  it('states the two rejected portal headers (cookie, x-csrf-token — never authorization)', () => {
    expect(REJECTED_PORTAL_HEADERS).toEqual(['cookie', 'x-csrf-token']);
  });

  it('TC-8: rejects a request carrying a cookie header, before anything else is checked', async () => {
    const guard = guardWith(TOKEN, { resolve: jest.fn() });
    const { context } = contextFor({ ...VALID_HEADERS, cookie: '__Host-rs_at=whatever' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('TC-8: rejects a request carrying an x-csrf-token header', async () => {
    const guard = guardWith(TOKEN, { resolve: jest.fn() });
    const { context } = contextFor({ ...VALID_HEADERS, 'x-csrf-token': 'anything' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('fails closed when CAMPAIGN_CONFIG_API_TOKEN is not configured', async () => {
    const guard = guardWith(undefined, { resolve: jest.fn() });
    const { context } = contextFor(VALID_HEADERS);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('TC-7: rejects a missing Authorization header', async () => {
    const guard = guardWith(TOKEN, { resolve: jest.fn() });
    const { context } = contextFor({ [SERVICE_IDENTITY_HEADER]: IDENTITY });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('TC-7: rejects an Authorization header that is not a Bearer token', async () => {
    const guard = guardWith(TOKEN, { resolve: jest.fn() });
    const { context } = contextFor({
      authorization: `Basic ${TOKEN}`,
      [SERVICE_IDENTITY_HEADER]: IDENTITY,
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('TC-7: rejects the wrong token, without ever calling the scope guard', async () => {
    const resolve = jest.fn();
    const guard = guardWith(TOKEN, { resolve });
    const { context } = contextFor({
      authorization: 'Bearer not-the-configured-token',
      [SERVICE_IDENTITY_HEADER]: IDENTITY,
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects a missing X-Service-Identity header', async () => {
    const guard = guardWith(TOKEN, { resolve: jest.fn() });
    const { context } = contextFor({ authorization: `Bearer ${TOKEN}` });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("TC-9's upstream half: an identity with no active grant is 401, not a 500", async () => {
    const resolve = jest
      .fn()
      .mockRejectedValue(new MutualTlsRequiredError('no active grant for this identity'));
    const guard = guardWith(TOKEN, { resolve });
    const { context } = contextFor(VALID_HEADERS);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(resolve).toHaveBeenCalledWith([IDENTITY]);
  });

  it('lets an unrelated error from the scope guard propagate unchanged', async () => {
    const boom = new Error('database is down');
    const guard = guardWith(TOKEN, { resolve: jest.fn().mockRejectedValue(boom) });
    const { context } = contextFor(VALID_HEADERS);

    await expect(guard.canActivate(context)).rejects.toBe(boom);
  });

  it('resolves the caller, attaches it to the request, and admits the call', async () => {
    const resolve = jest.fn().mockResolvedValue(resolved);
    const guard = guardWith(TOKEN, { resolve });
    const { context, request } = contextFor(VALID_HEADERS);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.serviceCaller).toBe(resolved);
    expect(resolve).toHaveBeenCalledWith([IDENTITY]);
  });

  it('trims whitespace around the presented X-Service-Identity header', async () => {
    const resolve = jest.fn().mockResolvedValue(resolved);
    const guard = guardWith(TOKEN, { resolve });
    const { context } = contextFor({
      authorization: `Bearer ${TOKEN}`,
      [SERVICE_IDENTITY_HEADER]: `  ${IDENTITY}  `,
    });

    await guard.canActivate(context);
    expect(resolve).toHaveBeenCalledWith([IDENTITY]);
  });
});
