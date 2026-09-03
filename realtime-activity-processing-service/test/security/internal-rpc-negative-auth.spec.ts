/**
 * T-RAP-042 — TC-3. Independent, spot-check confirmation that every internal RPC/consumer this
 * plan builds actually rejects an unauthenticated/wrong-identity/cross-customer caller before the
 * domain method is ever reached — not a re-derivation of `mtls.guard.spec.ts` (T-RAP-022) or
 * `progress-api.e2e-spec.ts`/`progress-api-token.spec.ts` (T-RAP-040)'s own exhaustive coverage,
 * which already exists and passes (confirmed by inspection + a full `npm test` run, see this
 * task's own completion report) — this file exercises the same two guards directly, from this
 * task's own independent test file, as the "actually attempt the bad case" proof
 * (Implementation note 1) rather than trusting that reading those files was enough.
 *
 * **Outbound gRPC clients this service itself makes** (`CampaignConfigClient` to the portal,
 * `RewardGrpcFallbackClient` to `reward-redemption-service`) have no "negative auth" test in the
 * usual inbound sense — they are the client, not the server, of that call. Their equivalent
 * security control is "never silently fall back to an insecure channel from a half-configured mTLS
 * setup" — already covered by `campaign-config.client.spec.ts`'s
 * `'rejects a partial TLS configuration'` and `reward-grpc-fallback.spec.ts`'s
 * `'loadRewardGrpcFallbackClientOptions rejects a partial TLS configuration'`, both confirmed
 * passing in this task's own full `npm test` run — not duplicated here since re-running the exact
 * same assertion from a second file would not add independent coverage, only a slower suite.
 */
import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { MtlsGuard } from '@/grpc/mtls.guard';
import { ServiceIdentityRegistry } from '@/grpc/service-identity.registry';
import { ResolvedIdentityContext } from '@/grpc/resolved-identity.context';
import {
  ProgressApiAuthGuard,
  type RequestWithProgressAuth,
} from '@/modules/progress-api/progress-api-auth.guard';
import { signProgressApiToken } from '@/modules/progress-api/progress-api-token';

const AUTH_SECRET = Buffer.alloc(32, 77).toString('base64');

function grpcContextWithNoCert(): ExecutionContext {
  return {
    getArgByIndex: () => ({ getAuthContext: () => ({}) }),
  } as unknown as ExecutionContext;
}

function grpcContextWithUnlistedIdentity(): ExecutionContext {
  return {
    getArgByIndex: () => ({
      getAuthContext: () => ({
        transportSecurityType: 'ssl',
        sslPeerCertificate: { subjectaltname: 'DNS:some-unlisted-caller' },
      }),
    }),
  } as unknown as ExecutionContext;
}

function httpContext(overrides: {
  authorization?: string;
  customerIdParam?: string;
}): ExecutionContext {
  const request = {
    headers: { authorization: overrides.authorization },
    params: { customerId: overrides.customerIdParam ?? 'CUST-1' },
  } as unknown as RequestWithProgressAuth;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('T-RAP-042 TC-3 — internal RPC/consumer negative-auth spot check', () => {
  describe('MtlsGuard (gRPC ingestion, T-RAP-022)', () => {
    it('rejects a call with no peer certificate at all (UNAUTHENTICATED)', () => {
      const guard = new MtlsGuard(
        new ServiceIdentityRegistry(new Map()),
        new ResolvedIdentityContext(),
      );
      expect(() => guard.canActivate(grpcContextWithNoCert())).toThrow(RpcException);
      try {
        guard.canActivate(grpcContextWithNoCert());
        throw new Error('expected canActivate to throw');
      } catch (error) {
        expect(error).toMatchObject({
          error: expect.objectContaining({ code: GrpcStatus.UNAUTHENTICATED }),
        });
      }
    });

    it('rejects a call whose certificate identity is not on the allowlist (PERMISSION_DENIED)', () => {
      const guard = new MtlsGuard(
        new ServiceIdentityRegistry(new Map([['a-different-allowed-caller', 1]])),
        new ResolvedIdentityContext(),
      );
      try {
        guard.canActivate(grpcContextWithUnlistedIdentity());
        throw new Error('expected canActivate to throw');
      } catch (error) {
        expect(error).toMatchObject({
          error: expect.objectContaining({ code: GrpcStatus.PERMISSION_DENIED }),
        });
      }
    });
  });

  describe('ProgressApiAuthGuard (customer progress HTTP API, T-RAP-040)', () => {
    beforeEach(() => {
      process.env.PROGRESS_API_AUTH_SECRET = AUTH_SECRET;
    });

    it('rejects a request with no Authorization header at all (401)', () => {
      const guard = new ProgressApiAuthGuard();
      expect(() => guard.canActivate(httpContext({}))).toThrow(UnauthorizedException);
    });

    it('rejects a well-formed but wrong-signature token (401)', () => {
      const guard = new ProgressApiAuthGuard();
      const forgedToken = `${Buffer.from(JSON.stringify({ tenantId: 1, customerId: 'CUST-1', exp: 9_999_999_999 })).toString('base64url')}.not-a-real-signature`;
      expect(() =>
        guard.canActivate(httpContext({ authorization: `Bearer ${forgedToken}` })),
      ).toThrow(UnauthorizedException);
    });

    it('rejects a validly-signed token for a DIFFERENT customerId than the URL (403, cross-customer)', () => {
      const guard = new ProgressApiAuthGuard();
      const token = signProgressApiToken(
        { tenantId: 1, customerId: 'CUST-OTHER', exp: Math.floor(Date.now() / 1000) + 3600 },
        Buffer.from(AUTH_SECRET, 'base64'),
      );
      expect(() =>
        guard.canActivate(
          httpContext({ authorization: `Bearer ${token}`, customerIdParam: 'CUST-1' }),
        ),
      ).toThrow(ForbiddenException);
    });
  });
});
