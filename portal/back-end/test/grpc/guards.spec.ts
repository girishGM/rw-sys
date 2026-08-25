/**
 * T-047 — the three checks every internal call passes, in isolation.
 *
 * The e2e suite proves them over a real TLS socket; these prove the decisions themselves, including
 * the combinations a socket makes awkward to arrange (a certificate with two SANs, an identity
 * holding both a global and a tenant-specific grant, an unknown section number from a newer
 * client). AGENT-PROTOCOL §4 holds guards to 100% coverage, and these are guards.
 */
import {
  assertMutualTls,
  assertNoPortalCredentials,
  serviceIdentityCandidates,
  REJECTED_PORTAL_HEADERS,
} from '@/grpc/mtls.guard';
import { ServiceScopeGuard } from '@/grpc/service-scope.guard';
import {
  resolveSections,
  includesSection,
  sectionName,
  sectionNumber,
} from '@/grpc/section-grant.guard';
import { ServiceRateLimiter } from '@/grpc/rate-limit';
import { GrpcAccessLog } from '@/grpc/access-log';
import { GrpcStatus } from '@/grpc/grpc.errors';
import { CONFIG_SECTION } from '@/grpc/grpc.constants';
import type { PeerIdentity } from '@/grpc/wire/grpc-http2.server';
import type {
  GrpcGrantsService,
  GrpcServiceGrant,
} from '@/modules/access-control/grpc-grants.service';

const peer = (overrides: Partial<PeerIdentity> = {}): PeerIdentity => ({
  authorized: true,
  authorizationError: null,
  subjectAltNames: ['DNS:txn-runtime.internal'],
  commonName: 'txn-runtime',
  hasCertificate: true,
  ...overrides,
});

const grant = (overrides: Partial<GrpcServiceGrant> = {}): GrpcServiceGrant => ({
  id: 1,
  serviceIdentity: 'txn-runtime.internal',
  tenantId: 7,
  allowedSections: ['BASIC', 'RULES'],
  status: 'active',
  createdBy: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('mtls.guard — the certificate (TC-9, TC-10, TC-12, TC-41)', () => {
  it('refuses a call with no client certificate — TC-9 at the application layer', () => {
    expect(() => assertMutualTls(peer({ hasCertificate: false }))).toThrow(
      /no client certificate was presented/,
    );
  });

  it('refuses a certificate the CA did not validate, quoting the reason', () => {
    expect(() =>
      assertMutualTls(
        peer({ authorized: false, authorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
      ),
    ).toThrow(/UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
  });

  it('falls back to a generic reason when the socket reports no authorization error', () => {
    expect(() => assertMutualTls(peer({ authorized: false, authorizationError: null }))).toThrow(
      /did not validate against the trusted CA/,
    );
  });

  it('accepts a valid certificate and hands back its identities, most specific first', () => {
    // The one path through `assertMutualTls` that does **not** throw. Easy to leave untested
    // precisely because every other case here is a refusal — and an `assertMutualTls` that threw
    // on a good certificate would take the whole runtime integration down.
    expect(assertMutualTls(peer())).toEqual(['txn-runtime.internal', 'txn-runtime']);
  });

  it('refuses a certificate with no usable identity at all', () => {
    expect(() =>
      assertMutualTls(peer({ subjectAltNames: ['IP:10.0.0.4'], commonName: null })),
    ).toThrow(/no DNS\/URI SAN and no CN/);
  });

  it('reads DNS and URI SANs, in order, with the type prefix stripped', () => {
    expect(
      serviceIdentityCandidates(
        peer({
          subjectAltNames: [
            'DNS:txn-runtime.internal',
            'URI:spiffe://cluster/ns/txn/sa/runtime',
            'IP:10.0.0.4',
          ],
          commonName: 'txn-runtime',
        }),
      ),
    ).toEqual(['txn-runtime.internal', 'spiffe://cluster/ns/txn/sa/runtime', 'txn-runtime']);
  });

  it('never treats an IP SAN as an identity — an address is a location', () => {
    expect(serviceIdentityCandidates(peer({ subjectAltNames: ['IP:10.0.0.4'] }))).toEqual([
      'txn-runtime',
    ]);
  });

  it('does not repeat an identity that appears as both a SAN and the CN', () => {
    expect(
      serviceIdentityCandidates(
        peer({ subjectAltNames: ['DNS:txn-runtime'], commonName: 'txn-runtime' }),
      ),
    ).toEqual(['txn-runtime']);
  });

  it.each(REJECTED_PORTAL_HEADERS)(
    'rejects a portal credential in the %s header — TC-12 / TC-41',
    (header) => {
      expect(() => assertNoPortalCredentials({ [header]: 'rp_at=abc' })).toThrow(
        /portal session credentials are not accepted/,
      );
    },
  );

  it('ignores an empty header rather than treating it as a credential', () => {
    expect(() => assertNoPortalCredentials({ cookie: '   ', authorization: [] })).not.toThrow();
  });

  it('passes a call carrying no portal header at all', () => {
    expect(() =>
      assertNoPortalCredentials({ 'content-type': 'application/grpc+proto' }),
    ).not.toThrow();
  });
});

describe('service-scope.guard — the tenant (TC-10, TC-11)', () => {
  const guardWith = (byIdentity: Record<string, GrpcServiceGrant[]>): ServiceScopeGuard =>
    new ServiceScopeGuard({
      activeGrantsFor: async (identity: string) => byIdentity[identity] ?? [],
    } as unknown as GrpcGrantsService);

  it('resolves the first candidate identity that holds any grant', async () => {
    const guard = guardWith({ 'spiffe://x': [grant({ serviceIdentity: 'spiffe://x' })] });
    const resolved = await guard.resolve(['unknown.internal', 'spiffe://x']);
    expect(resolved.identity).toBe('spiffe://x');
    expect(resolved.grants).toHaveLength(1);
  });

  it('refuses a CA-signed certificate that is in no grant — TC-10', async () => {
    const guard = guardWith({});
    await expect(guard.resolve(['stranger.internal'])).rejects.toThrow(
      /not in the service allowlist/,
    );
  });

  it('denies a tenant outside the grant with PERMISSION_DENIED, never NOT_FOUND — TC-11', () => {
    const guard = guardWith({});
    const resolved = { identity: 'txn', grants: [grant({ tenantId: 7 })] };
    expect(() => guard.grantFor(resolved, 9)).toThrow(/holds no active grant for tenant 9/);
    try {
      guard.grantFor(resolved, 9);
    } catch (error) {
      expect((error as { status: number }).status).toBe(GrpcStatus.PERMISSION_DENIED);
    }
  });

  it('prefers a tenant-specific grant over a global one', () => {
    const guard = guardWith({});
    const resolved = {
      identity: 'txn',
      grants: [
        grant({ id: 1, tenantId: null, allowedSections: ['BASIC', 'RULES', 'REWARDS'] }),
        grant({ id: 2, tenantId: 7, allowedSections: ['BASIC'] }),
      ],
    };
    expect(guard.grantFor(resolved, 7).id).toBe(2);
    expect(guard.grantFor(resolved, 8).id).toBe(1);
  });

  it('refuses a nonsensical tenant id without consulting the grants', () => {
    const guard = guardWith({});
    const resolved = { identity: 'txn', grants: [grant({ tenantId: null })] };
    expect(() => guard.grantFor(resolved, 0)).toThrow(/holds no active grant/);
    expect(() => guard.grantFor(resolved, -3)).toThrow(/holds no active grant/);
  });
});

describe('section-grant.guard — the slices (TC-30 … TC-33)', () => {
  it('returns every granted section, and lists the rest, when none was requested — TC-31', () => {
    const resolution = resolveSections('txn', ['BASIC', 'REWARDS', 'CAPS'], []);
    expect(resolution.returned).toEqual(['BASIC', 'REWARDS', 'CAPS']);
    expect(resolution.omitted).toEqual(['MERCHANTS', 'TRACKERS', 'RULES']);
  });

  it('returns BASIC plus the requested section, and omits nothing, on an explicit ask — TC-30', () => {
    const resolution = resolveSections(
      'txn',
      ['BASIC', 'REWARDS', 'CAPS'],
      [CONFIG_SECTION.REWARDS],
    );
    expect(resolution.returned).toEqual(['BASIC', 'REWARDS']);
    expect(resolution.omitted).toEqual([]);
    expect(includesSection(resolution, 'RULES')).toBe(false);
    expect(includesSection(resolution, 'CAPS')).toBe(false);
  });

  it('refuses an explicit request for an ungranted section, naming it — TC-32', () => {
    expect(() => resolveSections('txn', ['BASIC', 'REWARDS'], [CONFIG_SECTION.RULES])).toThrow(
      /is not granted section RULES/,
    );
  });

  it('adds BASIC even when the request did not name it — TC-33', () => {
    const resolution = resolveSections('txn', ['TRACKERS'], [CONFIG_SECTION.TRACKERS]);
    expect(resolution.returned).toEqual(['BASIC', 'TRACKERS']);
  });

  it('treats BASIC as granted to an identity granted anything at all', () => {
    const resolution = resolveSections('txn', ['REWARDS'], []);
    expect(resolution.returned).toContain('BASIC');
    expect(resolution.omitted).not.toContain('BASIC');
  });

  it('ignores UNSPECIFIED but refuses an unknown section number', () => {
    const resolution = resolveSections(
      'txn',
      ['BASIC'],
      [CONFIG_SECTION.CONFIG_SECTION_UNSPECIFIED],
    );
    expect(resolution.returned).toEqual(['BASIC']);
    expect(() => resolveSections('txn', ['BASIC'], [99])).toThrow(/CONFIG_SECTION\(99\)/);
  });

  it('maps section names and numbers both ways', () => {
    expect(sectionNumber('CAPS')).toBe(6);
    expect(sectionName(4)).toBe('RULES');
    expect(sectionName(0)).toBeNull();
    expect(sectionName(99)).toBeNull();
  });
});

describe('rate limit (TC-28)', () => {
  it('allows the limit and refuses the call after it', () => {
    const limiter = new ServiceRateLimiter(3, 60_000);
    limiter.consume('txn', 1_000);
    limiter.consume('txn', 1_001);
    limiter.consume('txn', 1_002);
    expect(() => limiter.consume('txn', 1_003)).toThrow(/exceeded 3 calls per minute/);
  });

  it('counts each identity separately', () => {
    const limiter = new ServiceRateLimiter(1, 60_000);
    limiter.consume('a', 0);
    expect(() => limiter.consume('b', 0)).not.toThrow();
    expect(() => limiter.consume('a', 0)).toThrow();
  });

  it('rolls the window over and forgets the old one', () => {
    const limiter = new ServiceRateLimiter(1, 1_000);
    limiter.consume('txn', 0);
    expect(() => limiter.consume('txn', 500)).toThrow();
    expect(() => limiter.consume('txn', 1_500)).not.toThrow();
  });

  it('reports RESOURCE_EXHAUSTED, which is what a gRPC client can act on', () => {
    const limiter = new ServiceRateLimiter(0, 60_000);
    try {
      limiter.consume('txn', 0);
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as { status: number }).status).toBe(GrpcStatus.RESOURCE_EXHAUSTED);
    }
  });

  it('defaults to the documented ceiling when Nest constructs it with no arguments', () => {
    // The `@Optional()` constructor parameters exist so `AppModule` can boot at all
    // (`rate-limit.ts`'s comment), and Nest passes `undefined` for both. A test that always
    // supplies explicit values never exercises the values production actually runs with.
    // Called without `now` as well, so the real `Date.now()` clock — the one every production
    // call uses — is exercised rather than only the injectable one the other tests pin.
    const limiter = new ServiceRateLimiter();
    expect(() => limiter.consume('txn')).not.toThrow();
    expect(() => limiter.consume('txn')).not.toThrow();
  });

  it('forgets an identity entirely once its window has expired', () => {
    // `sweep` runs on rollover, so a process that has seen a million one-off identities does not
    // hold a million windows. Asserted through the private map because the observable behaviour —
    // "the limit still works" — is identical either way, and the leak is the point.
    const limiter = new ServiceRateLimiter(5, 1_000);
    limiter.consume('a', 0);
    limiter.consume('b', 0);
    const windows = (limiter as unknown as { windows: Map<string, unknown> }).windows;
    expect(windows.size).toBe(2);
    limiter.consume('a', 2_000);
    expect([...windows.keys()]).toEqual(['a']);
  });
});

describe('access log (§7 — sampled, not one row per call)', () => {
  it('samples successful calls', () => {
    const log = new GrpcAccessLog(50);
    expect(log.shouldLog(GrpcStatus.OK)).toBe(true); // the first call of the window
    for (let index = 0; index < 49; index += 1) {
      log.record({
        method: 'GetCampaignConfig',
        identity: 'txn',
        tenantId: 7,
        status: GrpcStatus.OK,
        durationMs: 1,
      });
    }
    // 49 recorded so far; the 50th is the next sampled one.
    expect(log.shouldLog(GrpcStatus.OK)).toBe(false);
    log.record({
      method: 'GetCampaignConfig',
      identity: 'txn',
      tenantId: 7,
      status: GrpcStatus.OK,
      durationMs: 1,
    });
    expect(log.shouldLog(GrpcStatus.OK)).toBe(true);
  });

  it('always logs a denial, whatever the sampler says', () => {
    const log = new GrpcAccessLog(50);
    log.record({
      method: 'GetCampaignConfig',
      identity: 'txn',
      tenantId: 7,
      status: GrpcStatus.OK,
      durationMs: 1,
    });
    expect(log.shouldLog(GrpcStatus.PERMISSION_DENIED)).toBe(true);
    expect(log.shouldLog(GrpcStatus.UNAUTHENTICATED)).toBe(true);
    expect(log.shouldLog(GrpcStatus.RESOURCE_EXHAUSTED)).toBe(true);
    expect(log.shouldLog(GrpcStatus.INTERNAL)).toBe(true);
  });

  it('writes a line carrying the identity, tenant, campaign and status', () => {
    const log = new GrpcAccessLog(1);
    const written: string[] = [];
    jest
      .spyOn((log as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn')
      .mockImplementation((message: string) => {
        written.push(message);
      });
    log.record({
      method: 'GetCampaignConfig',
      identity: 'txn-runtime.internal',
      tenantId: 7,
      campaignCode: 'C1',
      sections: ['BASIC', 'RULES'],
      status: GrpcStatus.PERMISSION_DENIED,
      durationMs: 12,
    });
    expect(written[0]).toContain('identity=txn-runtime.internal');
    expect(written[0]).toContain('tenant=7');
    expect(written[0]).toContain('campaign=C1');
    expect(written[0]).toContain('sections=BASIC+RULES');
    expect(written[0]).toContain('status=PERMISSION_DENIED');
  });

  it('writes a successful call at log level, with dashes for what it does not know', () => {
    // The other half of `record`: a non-denial goes to `logger.log`, not `logger.warn`, and every
    // optional field renders as `-` rather than as `undefined` — a log line an operator greps.
    // Constructed with no arguments, which is how Nest constructs it (`access-log.ts`).
    const log = new GrpcAccessLog();
    const written: string[] = [];
    jest
      .spyOn((log as unknown as { logger: { log: (message: string) => void } }).logger, 'log')
      .mockImplementation((message: string) => {
        written.push(message);
      });
    log.record({
      method: 'ListActiveCampaigns',
      identity: 'txn-runtime.internal',
      tenantId: null,
      status: GrpcStatus.OK,
      durationMs: 3,
    });
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('tenant=-');
    expect(written[0]).toContain('campaign=-');
    expect(written[0]).toContain('sections=-');
    expect(written[0]).toContain('status=OK');
  });

  it('names an unrecognised status code rather than printing a bare number', () => {
    const log = new GrpcAccessLog(1);
    const written: string[] = [];
    jest
      .spyOn((log as unknown as { logger: { log: (message: string) => void } }).logger, 'log')
      .mockImplementation((message: string) => {
        written.push(message);
      });
    log.record({
      method: 'GetCampaignConfig',
      identity: 'txn',
      tenantId: 7,
      status: 12 as never,
      durationMs: 1,
    });
    expect(written[0]).toContain('status=UNKNOWN(12)');
  });
});
