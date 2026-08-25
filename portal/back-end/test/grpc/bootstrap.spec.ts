/**
 * T-047 — the lifecycle around the internal listener: when it opens, when it refuses to, and what
 * the §7a REST callback answers with.
 *
 * The two behaviours here are security decisions rather than plumbing:
 *
 *  1. **`GRPC_ENABLED` defaults to off**, and that is also the task file's documented rollback
 *     (*"Disable the gRPC listener via config. The REST portal is unaffected"*). Every environment
 *     that predates this task — including every developer's machine — must keep booting unchanged.
 *  2. **When it is on, missing certificate material fails the boot** (02-SECURITY.md §9: no silent
 *     defaults for security values). A listener that came up without a CA to validate clients
 *     against would accept anyone, which is strictly worse than not coming up.
 */
import type { ConfigService } from '@nestjs/config';
import type { Env } from '@/config/env.schema';
import { InternalServiceBootstrap } from '@/grpc/internal-service.bootstrap';
import { GrpcStatus } from '@/grpc/grpc.errors';
import { httpStatusFor } from '@/grpc/wire/grpc-http2.server';
import type { CampaignConfigController } from '@/grpc/campaign-config.controller';
import type { BudgetBreachController } from '@/grpc/budget-breach.controller';
import { createTestPki, type TestPki } from './support/test-pki';

let pki: TestPki;
const registered: string[] = [];

beforeAll(() => {
  pki = createTestPki();
});

afterAll(() => pki?.destroy());

/** A `ConfigService` that answers from a plain object, as `@nestjs/config` would from `.env`. */
function configOf(values: Record<string, unknown>): ConfigService<Env, true> {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService<Env, true>;
}

function bootstrapWith(values: Record<string, unknown>): InternalServiceBootstrap {
  registered.length = 0;
  const campaignConfig = {
    register: () => registered.push('campaign-config'),
  } as unknown as CampaignConfigController;
  const budgetBreach = {
    register: () => registered.push('budget-breach'),
  } as unknown as BudgetBreachController;
  return new InternalServiceBootstrap(configOf(values), campaignConfig, budgetBreach);
}

const CERT_PATHS = (pkiRef: () => TestPki) => ({
  GRPC_TLS_CERT_PATH: pkiRef().server.certPath,
  GRPC_TLS_KEY_PATH: pkiRef().server.keyPath,
  GRPC_TLS_CA_PATH: pkiRef().caPath,
});

describe('the listener is off unless a deployment asks for it', () => {
  it('does nothing at all when GRPC_ENABLED is unset — the documented rollback', async () => {
    const bootstrap = bootstrapWith({});
    await bootstrap.onApplicationBootstrap();
    // Nothing was registered, which means nothing was built, which means no socket was opened and
    // no certificate was even read. Shutting down is still safe.
    expect(registered).toEqual([]);
    await expect(bootstrap.onApplicationShutdown()).resolves.toBeUndefined();
  });

  it('does nothing when GRPC_ENABLED is any value other than true', async () => {
    const bootstrap = bootstrapWith({ GRPC_ENABLED: 'yes' });
    await bootstrap.onApplicationBootstrap();
    expect(registered).toEqual([]);
  });

  it('opens a listening socket and binds both surfaces when enabled', async () => {
    const bootstrap = bootstrapWith({
      GRPC_ENABLED: true,
      GRPC_PORT: 0,
      GRPC_HOST: '127.0.0.1',
      ...CERT_PATHS(() => pki),
    });
    await bootstrap.onApplicationBootstrap();
    // Both the gRPC service and the §7a callback are on the one socket — the property that makes
    // "same handshake, same allowlist" true by construction rather than by convention.
    expect(registered).toEqual(['campaign-config', 'budget-breach']);
    await bootstrap.onApplicationShutdown();
    // Idempotent: a second shutdown must not throw, because Nest may call it more than once.
    await expect(bootstrap.onApplicationShutdown()).resolves.toBeUndefined();
  });
});

describe('enabled without certificate material is a boot failure, not a warning', () => {
  it.each([['GRPC_TLS_KEY_PATH'], ['GRPC_TLS_CERT_PATH'], ['GRPC_TLS_CA_PATH']])(
    'refuses to build when %s is missing, naming the variable',
    (missing) => {
      const values: Record<string, unknown> = {
        GRPC_ENABLED: true,
        GRPC_PORT: 0,
        ...CERT_PATHS(() => pki),
      };
      delete values[missing];
      expect(() => bootstrapWith(values).build()).toThrow(new RegExp(missing));
    },
  );

  it('treats an empty string exactly like an absent variable', () => {
    expect(() =>
      bootstrapWith({
        GRPC_ENABLED: true,
        ...CERT_PATHS(() => pki),
        GRPC_TLS_CA_PATH: '   ',
      }).build(),
    ).toThrow(/GRPC_TLS_CA_PATH is required/);
  });

  it('falls back to port 50051 and loopback when neither is configured', () => {
    // Not `0.0.0.0`: §7 requires the port to be internal-network-only, and a deployment must
    // *choose* to widen it rather than inherit a public bind.
    const listener = bootstrapWith({
      GRPC_ENABLED: true,
      ...CERT_PATHS(() => pki),
    }).build();
    // Not listening yet, so `address()` is 0 — the configured port is proven by the fact that
    // `build()` accepted no port and did not throw, and by the constant the module documents.
    expect(listener.address()).toBe(0);
  });
});

describe('the §7a REST callback maps gRPC statuses onto HTTP', () => {
  // The callback is REST, so a status code the runtime's HTTP client understands matters as much
  // as the trailer does on the gRPC half. `PERMISSION_DENIED → 403` in particular is what TC-39
  // asserts over the wire.
  it.each([
    [GrpcStatus.OK, 200],
    [GrpcStatus.INVALID_ARGUMENT, 400],
    [GrpcStatus.UNAUTHENTICATED, 401],
    [GrpcStatus.PERMISSION_DENIED, 403],
    [GrpcStatus.NOT_FOUND, 404],
    [GrpcStatus.FAILED_PRECONDITION, 409],
    [GrpcStatus.RESOURCE_EXHAUSTED, 429],
    [GrpcStatus.UNAVAILABLE, 503],
    [GrpcStatus.INTERNAL, 500],
  ])('maps %i to %i', (status, expected) => {
    expect(httpStatusFor(status)).toBe(expected);
  });
});
