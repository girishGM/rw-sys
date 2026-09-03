/**
 * T-RAP-022. Fast, mocked-dependency unit tests for `MtlsGuard` — the real-mTLS/real-Postgres round
 * trip (TC-1..TC-3, TC-6) lives in `grpc-server.e2e-spec.ts` instead, same split
 * `promo-code.controller.spec.ts`/`grpc-server.e2e-spec.ts` (T-PC-031) already established for the
 * sibling project.
 */
import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { MtlsGuard } from '@/grpc/mtls.guard';
import { ServiceIdentityRegistry } from '@/grpc/service-identity.registry';
import { ResolvedIdentityContext } from '@/grpc/resolved-identity.context';

function fakeContextWithCall(call: unknown): ExecutionContext {
  return {
    getArgByIndex: () => call,
  } as unknown as ExecutionContext;
}

function authContextCall(
  peerCertificate: {
    subjectaltname?: string;
    subject?: Record<string, string>;
  } | null,
): unknown {
  return {
    getAuthContext: () => ({
      transportSecurityType: peerCertificate ? 'ssl' : undefined,
      sslPeerCertificate: peerCertificate ?? undefined,
    }),
  };
}

function buildGuard(entries: [string, number][]): MtlsGuard {
  const registry = new ServiceIdentityRegistry(new Map(entries));
  const identityContext = new ResolvedIdentityContext();
  return new MtlsGuard(registry, identityContext);
}

/** Captures whatever `fn` throws (or `undefined` if it doesn't) — avoids relying on a `fail()`
 * global, which modern Jest (this project's version) does not provide. */
function captureThrown(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('T-RAP-022 — MtlsGuard (unit, mocked registry)', () => {
  it('rejects (UNAUTHENTICATED) when the call context exposes no getAuthContext at all', () => {
    const guard = buildGuard([]);
    const context = fakeContextWithCall({});

    const error = captureThrown(() => guard.canActivate(context));
    expect(error).toBeInstanceOf(RpcException);
    expect(error).toMatchObject({
      error: expect.objectContaining({ code: GrpcStatus.UNAUTHENTICATED }),
    });
  });

  it('rejects (UNAUTHENTICATED) when no peer certificate is present', () => {
    const guard = buildGuard([]);
    const context = fakeContextWithCall(authContextCall(null));

    expect(() => guard.canActivate(context)).toThrow(RpcException);
  });

  // TC-3: wrong/missing service identity is rejected before the domain method is ever reached.
  it('rejects (PERMISSION_DENIED) when the SAN has no active allowlist match', () => {
    const guard = buildGuard([['some-other-service-not-listed', 1]]);
    const context = fakeContextWithCall(authContextCall({ subjectaltname: 'DNS:not-allowed' }));

    const error = captureThrown(() => guard.canActivate(context));
    expect(error).toMatchObject({
      error: expect.objectContaining({ code: GrpcStatus.PERMISSION_DENIED }),
    });
  });

  it('allows the call through and records the resolved tenantId when the SAN matches an allowlist entry', () => {
    const registry = new ServiceIdentityRegistry(new Map([['upstream-service', 42]]));
    const identityContext = new ResolvedIdentityContext();
    const guard = new MtlsGuard(registry, identityContext);
    const call = authContextCall({ subjectaltname: 'DNS:upstream-service, DNS:extra' });
    const context = fakeContextWithCall(call);

    expect(guard.canActivate(context)).toBe(true);
    expect(identityContext.get(call as object)).toBe(42);
  });

  it('falls back to the certificate CN when no SAN is present', () => {
    const registry = new ServiceIdentityRegistry(new Map([['cn-identity', 7]]));
    const identityContext = new ResolvedIdentityContext();
    const guard = new MtlsGuard(registry, identityContext);
    const call = authContextCall({ subject: { CN: 'cn-identity' } });
    const context = fakeContextWithCall(call);

    expect(guard.canActivate(context)).toBe(true);
    expect(identityContext.get(call as object)).toBe(7);
  });

  it('rejects (PERMISSION_DENIED) when the certificate has neither a SAN nor a CN', () => {
    const guard = buildGuard([]);
    const context = fakeContextWithCall(authContextCall({}));

    const error = captureThrown(() => guard.canActivate(context));
    expect(error).toMatchObject({
      error: expect.objectContaining({ code: GrpcStatus.PERMISSION_DENIED }),
    });
  });
});

describe('T-RAP-022 — ServiceIdentityRegistry (unit)', () => {
  it('resolves the first candidate identity present in the allowlist', () => {
    const registry = new ServiceIdentityRegistry(
      new Map([
        ['identity-a', 1],
        ['identity-b', 2],
      ]),
    );
    expect(registry.resolveTenantId(['not-listed', 'identity-b'])).toBe(2);
  });

  it('returns undefined when no candidate is on the allowlist', () => {
    const registry = new ServiceIdentityRegistry(new Map([['identity-a', 1]]));
    expect(registry.resolveTenantId(['not-listed'])).toBeUndefined();
  });
});
