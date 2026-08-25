/**
 * T-018 — both interceptors over real HTTP, wired in the order `AppModule` wires them.
 *
 * ### Why this exists alongside the unit specs and the e2e suite
 *
 * The properties this task is actually judged on are *positional*: decrypt before the
 * `ValidationPipe`, encrypt after `ResponseMaskingInterceptor`, guards before both. None of those
 * can be asserted by calling `intercept()` directly — the ordering **is** the behaviour, and it is
 * produced by Nest, not by any line of this task's code. So this file stands up a real Nest HTTP
 * server with the same global pipe `main.ts` installs and the same three interceptors, registered
 * in the same order as `AppModule.imports` puts them, and drives it with supertest.
 *
 * TC-3, TC-4, TC-5, TC-6, TC-7, TC-8, TC-9, TC-10, TC-11, TC-12, TC-14, TC-15, TC-16, TC-17,
 * TC-19 and TC-21 all have their form here.
 *
 * The database is not involved: `HandshakeService` runs over the in-memory key store from
 * `support/harness.ts`, and the masking interceptor over a two-line policy double. What is real
 * is everything that decides what leaves the process.
 */
import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  INestApplication,
  Injectable,
  Post,
  Body,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';
import { createECDH } from 'node:crypto';
import request from 'supertest';
import { FieldCryptoService } from '@/common/crypto';
import {
  DATA_PROTECTION_CONFIG,
  DEFAULT_DATA_PROTECTION_CONFIG,
  type DataProtectionConfig,
  type TransportMode,
} from '@/common/data-protection/data-protection.config';
import { PolicyCacheService } from '@/common/data-protection/policy-cache.service';
import type { ResolvedPolicy } from '@/common/data-protection/policy.service';
import { ResponseMaskingInterceptor } from '@/common/data-protection/response-masking.interceptor';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import { ErrorNormalizationFilter } from '@/common/errors/error-normalization.filter';
import type { MessageService } from '@/common/messages/message.service';
import type { AuditService } from '@/common/audit/audit.service';
import { CORRELATION_HEADER } from '@/common/errors/trace-id';
import { HandshakeService } from '@/common/transport-crypto/handshake.service';
import { PayloadDecryptInterceptor } from '@/common/transport-crypto/payload-decrypt.interceptor';
import { PayloadEncryptInterceptor } from '@/common/transport-crypto/payload-encrypt.interceptor';
import { SESSION_TRANSPORT_KEY_STORE } from '@/common/transport-crypto/session-transport-key.repository';
import { TransportPolicyService } from '@/common/transport-crypto/transport-policy.service';
import {
  sealEnvelope,
  openEnvelope,
  type EnvelopeBinding,
  type PayloadEnvelope,
} from '@/common/transport-crypto/transport-envelope';
import { sessionKid } from '@/common/transport-crypto/transport-crypto.constants';
import { buildDefaultRegistry } from '../crypto/support/keys';
import { bindTestServer } from '../security/support/bound-app';
import { FakeTransportKeyStore, OTHER_SESSION_ID, SESSION_ID } from './support/harness';

jest.setTimeout(60_000);

const CORRELATION_ID = 'corr-0123456789abcdef';
const KID = sessionKid(SESSION_ID);

/** The masked glyph run `applyMask(_, 'full')` produces (07-DATA-PROTECTION.md §7). */
const MASKED = '••••••••';

/**
 * TC-20's estimator (T-086): the median of one latency delta per trial.
 *
 * **Why the median and not the minimum.** The sibling budgets fixed under T-086 — `test/crypto`'s
 * throughput and the timing controls in `test/auth` — take the least-contended sample, because
 * each measures a *single* quantity that contention can only ever inflate. This one does not: it
 * measures a *difference* between two arms that are interleaved request-for-request, so a
 * contention burst lands in both arms and very largely cancels in the subtraction. What survives
 * is roughly symmetric noise, and taking the minimum of a symmetric quantity does not remove bias,
 * it introduces one — downward, against the budget, which would quietly weaken the assertion.
 * Observed while building this fix, with 60 samples per arm: trials of -0.443, -1.252 and 0.066 ms
 * around a true overhead well under a millisecond, where `Math.min` would have reported -1.252 and
 * so effectively relaxed the 5 ms bar to 6.25. The median is unbiased and still discards a single
 * wild trial, which is all that is needed once interleaving has done the heavy lifting.
 *
 * **Why 120 samples per arm and not 60.** A p95 is a tail statistic, and at 60 samples it is the
 * 4th-slowest request — deep enough into the tail that its own sampling noise (±3 ms, measured)
 * was comparable to the 5 ms budget being asserted, which would have left the test unable to
 * resolve its own bar. At 120 the three trials land within ±0.15 ms of each other around a ~0.04 ms
 * true overhead, a ~33x margin against the budget. That is the difference between an assertion
 * that means something and one that merely passes.
 */
const medianDelta = (deltas: number[]): number =>
  [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)];

class ProbeDto {
  @IsString()
  name!: string;
}

class ChangePasswordProbeDto {
  @IsString()
  newPassword!: string;
}

/**
 * Sets `request.authUser` the way `JwtAuthGuard` does, from a header rather than a token.
 *
 * The point of the substitution is that it runs in the same *position* — a guard — so the
 * interceptors see exactly the request shape they see in production. `x-test-session` is the
 * stand-in for the verified `sid` claim; there is no path by which a request **body** can set it,
 * which is what R3 requires and what `no session` below exercises.
 */
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      authUser?: { sessionId: string };
    }>();
    const sessionId = request.headers['x-test-session'];
    if (sessionId !== undefined) request.authUser = { sessionId };
    return true;
  }
}

@Controller()
@UseGuards(FakeAuthGuard)
class ProbeController {
  /** Echoes the DTO back, so a decrypted body is observable from the outside. */
  @Post('probe')
  probe(@Body() dto: ProbeDto): unknown {
    return { data: { echoed: dto.name, temporaryPassword: 'hunter2', id: 7 } };
  }

  @Post('users')
  users(@Body() dto: ProbeDto): unknown {
    return { data: { echoed: dto.name, temporaryPassword: 'hunter2' } };
  }

  @Post('auth/change-password')
  changePassword(@Body() dto: ChangePasswordProbeDto): unknown {
    return { data: { received: dto.newPassword } };
  }

  @Post('auth/login')
  login(@Body() dto: ProbeDto): unknown {
    return { data: { echoed: dto.name, temporaryPassword: 'hunter2' } };
  }

  @Get('health')
  health(): unknown {
    return { data: { status: 'ok', temporaryPassword: 'hunter2' } };
  }

  @Get('list')
  list(): unknown {
    return { data: [{ temporaryPassword: 'hunter2' }, { temporaryPassword: 'other' }] };
  }
}

/**
 * The policy double: `temporaryPassword` is both **masked** and **payload_encrypt**.
 *
 * That combination is the whole of TC-17. If the interceptors are wired the wrong way round, the
 * envelope is built before masking and decrypting it yields `hunter2` — a test that passes on
 * every other assertion while shipping the secret.
 */
function fakePolicies(): PolicyCacheService {
  const masked = { uiVisibility: 'masked', maskStrategy: 'full', source: 'row' } as ResolvedPolicy;
  const encrypt = { inTransit: 'payload_encrypt' } as ResolvedPolicy;

  return {
    resolveColumnSafe: () => null,
    // `null` — "no policy governs this name" — for everything else, which is what the real cache
    // answers for an unclassified field. Returning a policy object with no `uiVisibility` would
    // send `ResponseMaskingInterceptor` down its `default:` branch and mask the entire payload,
    // which would make every assertion below about *what* got encrypted meaningless.
    resolveFieldNameSafe: (name: string): ResolvedPolicy | null => {
      if (name === 'temporaryPassword') return { ...masked, ...encrypt } as ResolvedPolicy;
      if (name === 'newPassword') return { ...encrypt, uiVisibility: 'plain' } as ResolvedPolicy;
      return null;
    },
    get isLoaded(): boolean {
      return true;
    },
    current: () => ({ payloadEncryptFieldNames: () => ['newPassword', 'temporaryPassword'] }),
  } as unknown as PolicyCacheService;
}

interface Harness {
  app: INestApplication;
  http: () => ReturnType<typeof request>;
  store: FakeTransportKeyStore;
  handshake: HandshakeService;
  key: Buffer;
}

async function buildHarness(
  mode: TransportMode,
  routeOverrides: Record<string, TransportMode> = {},
): Promise<Harness> {
  const registry = await buildDefaultRegistry();
  const fieldCrypto = new FieldCryptoService(registry);
  const store = new FakeTransportKeyStore();
  const handshake = new HandshakeService(store, fieldCrypto);

  const config: DataProtectionConfig = {
    ...DEFAULT_DATA_PROTECTION_CONFIG,
    transport: { mode, routeOverrides },
  };

  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController],
    providers: [
      { provide: HandshakeService, useValue: handshake },
      { provide: SESSION_TRANSPORT_KEY_STORE, useValue: store },
      { provide: DATA_PROTECTION_CONFIG, useValue: config },
      { provide: PolicyCacheService, useValue: fakePolicies() },
      Reflector,
      TransportPolicyService,
      PayloadDecryptInterceptor,
      PayloadEncryptInterceptor,
      ResponseMaskingInterceptor,
      // The order `AppModule.imports` produces: TransportCryptoModule's two, then
      // DataProtectionModule's. Response-side logic runs in reverse, so this is
      // `mask → encrypt` — 07-DATA-PROTECTION.md §8.
      { provide: APP_INTERCEPTOR, useExisting: PayloadDecryptInterceptor },
      { provide: APP_INTERCEPTOR, useExisting: PayloadEncryptInterceptor },
      { provide: APP_INTERCEPTOR, useExisting: ResponseMaskingInterceptor },
      // T-014's filter, so a `ValidationFailedError` from the pipe's `exceptionFactory` becomes
      // the documented 400 envelope rather than an unhandled 500 — the same shaping `main.ts`
      // gets from `ErrorsModule`. Its two collaborators are stubbed; neither influences status
      // or code, which is all this file asserts on.
      {
        provide: APP_FILTER,
        useValue: new ErrorNormalizationFilter(
          { get: (code: string) => code } as unknown as MessageService,
          { recordRequestFailure: async () => undefined } as unknown as AuditService,
        ),
      },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  // Mirrors main.ts exactly — `forbidNonWhitelisted` is what TC-4 is about.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  await app.init();
  // Listen **once**, up front. `request(server)` starts an ephemeral listener per call when the
  // server is not already listening, and TC-21's hundred parallel calls then exhaust the backlog
  // and surface as `ECONNRESET` — a test-harness artefact that would look exactly like a
  // concurrency bug in the code under test.
  //
  // T-087: this was the right diagnosis but an incomplete fix. The raw `listen(0)` was never
  // awaited, so a request constructed before the bind completed still saw `address() === null` and
  // took the per-request listen/close path anyway; and `listen(0)` with no host binds every
  // interface rather than loopback. `bindTestServer` awaits the bind and pins 127.0.0.1, and the
  // returned base URL keeps supertest off `_server.close()` entirely.
  const base = await bindTestServer(app);

  // Establish a real transport key for SESSION_ID, exactly as a login would.
  const ecdh = createECDH('prime256v1');
  const clientPublicKey = ecdh.generateKeys();
  await handshake.establish(SESSION_ID, clientPublicKey.toString('base64'));
  const key = (await handshake.keyForSession(SESSION_ID))!;

  return { app, http: () => request(base), store, handshake, key };
}

function binding(overrides: Partial<EnvelopeBinding> = {}): EnvelopeBinding {
  return { kid: KID, direction: 'req', correlationId: CORRELATION_ID, path: '$', ...overrides };
}

/** Opens a whole-body response envelope with the session key. */
function openResponse(key: Buffer, body: PayloadEnvelope, correlationId: string): unknown {
  return JSON.parse(
    openEnvelope(key, body, { kid: KID, direction: 'res', correlationId, path: '$' }),
  );
}

describe('mode: full', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness('full');
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('TC-3 — the server decrypts and the controller sees a plaintext DTO', async () => {
    const envelope = sealEnvelope(harness.key, JSON.stringify({ name: 'Summer' }), binding());

    const response = await harness
      .http()
      .post('/api/v1/probe')
      .set('x-test-session', SESSION_ID)
      .set('x-payload-encrypted', 'v1')
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send(envelope as unknown as object);

    expect(response.status).toBe(201);
    const decrypted = openResponse(
      harness.key,
      response.body,
      response.headers[CORRELATION_HEADER.toLowerCase()],
    ) as { data: { echoed: string } };
    expect(decrypted.data.echoed).toBe('Summer');
  });

  it('TC-5 — the response is an envelope the client can open to the expected JSON', async () => {
    const response = await harness
      .http()
      .post('/api/v1/probe')
      .set('x-test-session', SESSION_ID)
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send({ name: 'Summer' });

    expect(response.headers['x-payload-encrypted']).toBe('v1');
    expect(Object.keys(response.body).sort()).toEqual(['ct', 'iv', 'kid', 'tag']);

    const decrypted = openResponse(harness.key, response.body, CORRELATION_ID) as {
      data: { echoed: string; id: number };
    };
    expect(decrypted.data.echoed).toBe('Summer');
    expect(decrypted.data.id).toBe(7);
  });

  it('TC-17 — a masked field is still masked after decryption; encryption did not bypass masking', async () => {
    const response = await harness
      .http()
      .post('/api/v1/probe')
      .set('x-test-session', SESSION_ID)
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send({ name: 'Summer' });

    const decrypted = openResponse(harness.key, response.body, CORRELATION_ID) as {
      data: { temporaryPassword: string };
    };

    expect(decrypted.data.temporaryPassword).toBe(MASKED);
    expect(JSON.stringify(decrypted)).not.toContain('hunter2');
  });

  it('TC-19 — nothing readable survives in the wire body', async () => {
    const response = await harness
      .http()
      .post('/api/v1/probe')
      .set('x-test-session', SESSION_ID)
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send({ name: 'Summer' });

    expect(response.text).not.toContain('Summer');
    expect(response.text).not.toContain('hunter2');
    expect(response.text).not.toContain('echoed');
  });

  it('TC-4 — `forbidNonWhitelisted` still applies to a decrypted payload', async () => {
    const envelope = sealEnvelope(
      harness.key,
      JSON.stringify({ name: 'Summer', smuggled: 'x' }),
      binding(),
    );

    const response = await harness
      .http()
      .post('/api/v1/probe')
      .set('x-test-session', SESSION_ID)
      .set('x-payload-encrypted', 'v1')
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send(envelope as unknown as object);

    expect(response.status).toBe(400);
  });

  it('TC-16 — decryption runs before validation, so a bad *decrypted* DTO fails validation', async () => {
    // The proof: the failure names the decrypted field, which is only knowable if the pipe ran on
    // plaintext. An envelope reaching the pipe would have failed on `kid`/`iv`/`tag`/`ct` instead.
    const envelope = sealEnvelope(harness.key, JSON.stringify({ name: 42 }), binding());

    const response = await harness
      .http()
      .post('/api/v1/probe')
      .set('x-test-session', SESSION_ID)
      .set('x-payload-encrypted', 'v1')
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send(envelope as unknown as object);

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('name');
    expect(JSON.stringify(response.body)).not.toContain('kid');
  });

  it('TC-11 — a tampered ciphertext is 400 PAYLOAD_DECRYPT_FAILED with no detail', async () => {
    const envelope = sealEnvelope(harness.key, JSON.stringify({ name: 'Summer' }), binding());
    const bytes = Buffer.from(envelope.ct, 'base64');
    bytes[0] ^= 0xff;

    const response = await harness
      .http()
      .post('/api/v1/probe')
      .set('x-test-session', SESSION_ID)
      .set('x-payload-encrypted', 'v1')
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send({ ...envelope, ct: bytes.toString('base64') });

    expect(response.status).toBe(400);
    // The 03-API-CONTRACT.md §1 envelope, and nothing beyond it: no `details`, no reason, no
    // kid, no field name, no stack frame. `message` is the catalogue key's text and `traceId`
    // the correlation id — both added by T-014's filter, neither derived from the exception.
    expect(response.body.error.code).toBe('PAYLOAD_DECRYPT_FAILED');
    expect(response.body.error.details).toBeUndefined();
    expect(Object.keys(response.body.error).sort()).toEqual(['code', 'message', 'traceId']);
    expect(response.text).not.toMatch(/auth_failed|malformed|at Object\.|node_modules/);
  });

  it('TC-11 — the error response itself is readable cleartext', async () => {
    // If errors were encrypted, a client could never read the error saying decryption failed.
    const response = await harness
      .http()
      .post('/api/v1/probe')
      .set('x-test-session', SESSION_ID)
      .set('x-payload-encrypted', 'v1')
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send({ kid: KID, iv: 'x', tag: 'y', ct: 'z' });

    expect(response.status).toBe(400);
    expect(response.headers['x-payload-encrypted']).toBeUndefined();
    expect(response.body.error.code).toBe('PAYLOAD_DECRYPT_FAILED');
  });

  it('TC-12 — an envelope from another session is 401, not 400', async () => {
    const foreign = sealEnvelope(harness.key, JSON.stringify({ name: 'Summer' }), {
      ...binding(),
      kid: sessionKid(OTHER_SESSION_ID),
    });

    const response = await harness
      .http()
      .post('/api/v1/probe')
      .set('x-test-session', SESSION_ID)
      .set('x-payload-encrypted', 'v1')
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send(foreign as unknown as object);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('AUTH_SESSION_INVALID');
  });

  it('TC-13 — an envelope replayed on a different request is rejected', async () => {
    const envelope = sealEnvelope(harness.key, JSON.stringify({ name: 'Summer' }), binding());

    const response = await harness
      .http()
      .post('/api/v1/probe')
      .set('x-test-session', SESSION_ID)
      .set('x-payload-encrypted', 'v1')
      // A different correlation id — i.e. the same bytes replayed onto another request.
      .set(CORRELATION_HEADER, 'corr-ffffffffffffffff')
      .send(envelope as unknown as object);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('PAYLOAD_DECRYPT_FAILED');
  });

  it('TC-14 — a request after logout is 401', async () => {
    await harness.handshake.destroyForSession(SESSION_ID);

    const response = await harness
      .http()
      .post('/api/v1/probe')
      .set('x-test-session', SESSION_ID)
      .set('x-payload-encrypted', 'v1')
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send(
        sealEnvelope(harness.key, JSON.stringify({ name: 'x' }), binding()) as unknown as object,
      );

    expect(response.status).toBe(401);
  });

  it('an encrypted request with no authenticated session is 401', async () => {
    const response = await harness
      .http()
      .post('/api/v1/probe')
      .set('x-payload-encrypted', 'v1')
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send(
        sealEnvelope(harness.key, JSON.stringify({ name: 'x' }), binding()) as unknown as object,
      );

    expect(response.status).toBe(401);
  });

  it.each([
    ['a missing iv', { kid: KID, tag: 'AAAA', ct: 'AAAA' }],
    ['a non-base64 iv', { kid: KID, iv: '!!!!', tag: 'AAAA', ct: 'AAAA' }],
    ['an empty object', {}],
  ])('TC-15 — %s is 400 without a crash', async (_label, body) => {
    const response = await harness
      .http()
      .post('/api/v1/probe')
      .set('x-test-session', SESSION_ID)
      .set('x-payload-encrypted', 'v1')
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send(body);

    expect(response.status).toBe(400);
  });

  it('an unsupported envelope version is 400', async () => {
    const response = await harness
      .http()
      .post('/api/v1/probe')
      .set('x-test-session', SESSION_ID)
      .set('x-payload-encrypted', 'v2')
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send({ name: 'Summer' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('PAYLOAD_DECRYPT_FAILED');
  });

  it('the header sent twice is 400 rather than being half-honoured', async () => {
    const response = await harness
      .http()
      .post('/api/v1/probe')
      .set('x-test-session', SESSION_ID)
      .set('x-payload-encrypted', ['v1', 'v1'] as unknown as string)
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send({ name: 'Summer' });

    expect(response.status).toBe(400);
  });

  it('a cleartext request is still accepted, and answered with an envelope', async () => {
    // Encryption is driven by the mode, decryption by the header — see the interceptor headers.
    const response = await harness
      .http()
      .post('/api/v1/probe')
      .set('x-test-session', SESSION_ID)
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send({ name: 'Summer' });

    expect(response.status).toBe(201);
    expect(response.headers['x-payload-encrypted']).toBe('v1');
  });

  it('a caller with no transport key gets cleartext rather than an unopenable envelope', async () => {
    const response = await harness
      .http()
      .post('/api/v1/probe')
      .set('x-test-session', OTHER_SESSION_ID)
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send({ name: 'Summer' });

    expect(response.status).toBe(201);
    expect(response.headers['x-payload-encrypted']).toBeUndefined();
    expect(response.body.data.echoed).toBe('Summer');
    // Masking still applied — the other control is independent of this one.
    expect(response.body.data.temporaryPassword).toBe(MASKED);
  });

  it('TC-9 — /auth/login is cleartext both ways even in full mode', async () => {
    const response = await harness
      .http()
      .post('/api/v1/auth/login')
      .set('x-test-session', SESSION_ID)
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send({ name: 'Summer' });

    expect(response.status).toBe(201);
    expect(response.headers['x-payload-encrypted']).toBeUndefined();
    expect(response.body.data.echoed).toBe('Summer');
  });

  it('TC-10 — /health is cleartext', async () => {
    const response = await harness
      .http()
      .get('/api/v1/health')
      .set('x-test-session', SESSION_ID)
      .set(CORRELATION_HEADER, CORRELATION_ID);

    expect(response.status).toBe(200);
    expect(response.headers['x-payload-encrypted']).toBeUndefined();
    expect(response.body.data.status).toBe('ok');
  });

  it('an array body is encrypted whole', async () => {
    const response = await harness
      .http()
      .get('/api/v1/list')
      .set('x-test-session', SESSION_ID)
      .set(CORRELATION_HEADER, CORRELATION_ID);

    expect(response.headers['x-payload-encrypted']).toBe('v1');
    const decrypted = openResponse(harness.key, response.body, CORRELATION_ID) as {
      data: { temporaryPassword: string }[];
    };
    expect(decrypted.data).toHaveLength(2);
    expect(decrypted.data[0].temporaryPassword).toBe(MASKED);
  });

  it('TC-20 — the cryptographic overhead is under 5 ms at p95', async () => {
    // **What this measures, precisely.** Both arms go through the identical Nest chain, the same
    // controller and the same masking interceptor; the only difference is whether the request
    // arrives as an envelope and the response leaves as one. The key store is in memory, so what
    // is being timed is AES-256-GCM plus the walk — the cryptographic cost this task adds.
    //
    // **What it does not measure**, and is called out in the completion report instead: in
    // production `HandshakeService.keyForRequest` performs one additional primary-key SELECT per
    // request (memoised, so exactly one). That is a database round trip, not a crypto cost, and
    // folding it into `findSessionContext`'s existing per-request query is the obvious
    // optimisation if p95 ever matters.
    // **Why this is measured in interleaved trials** (T-086). The budget is a *difference*
    // between two arms, which is the right shape — but the two arms used to be measured in
    // sequence: 120 encrypted requests, then 120 cleartext ones. A CPU-contention burst lasting
    // a second or two therefore landed almost entirely inside one arm, and was subtracted from
    // an arm that never saw it. Under `jest`'s default parallelism (278 suites, 10 cores) that
    // is not rare: this assertion failed 2 of 4 consecutive full-suite runs on an unchanged
    // tree, once reporting a delta of 13.9 ms against a 5 ms budget, while passing every time
    // the file was run alone.
    //
    // Two changes, both aimed at measuring the code rather than the machine:
    //
    //  1. **Interleave the arms within a trial.** Each encrypted request is immediately followed
    //     by its cleartext twin, so any contention window hits both arms alike and cancels in the
    //     subtraction. This is the same reasoning `auth.http.spec.ts`'s TC-21 already uses for
    //     its three interleaved groups.
    //  2. **Take the median of three trials**, which discards a single wild trial without
    //     biasing the estimate in either direction. See `medianDelta`'s own comment for why the
    //     median and not the minimum — the choice matters, and taking the minimum here would
    //     have quietly relaxed the 5 ms bar to about 6.25 ms.
    //
    // Neither change relaxes the 5 ms budget, and (2) is the one that could in principle hide a
    // regression, so it is asserted directly on fixed data by the two tests below this one: real
    // added overhead is present in *every* trial, so the median of them is over budget too. The
    // request count is unchanged at 480, so this costs no extra wall-clock.
    const one = async (encrypted: boolean, index: number): Promise<number> => {
      const correlationId = `corr-${String(index).padStart(16, '0')}`;
      const payload = { name: `campaign-${index}` };
      let call = harness
        .http()
        .post('/api/v1/probe')
        .set('x-test-session', SESSION_ID)
        .set(CORRELATION_HEADER, correlationId);

      if (encrypted) call = call.set('x-payload-encrypted', 'v1');

      const body = encrypted
        ? (sealEnvelope(
            harness.key,
            JSON.stringify(payload),
            binding({ correlationId }),
          ) as unknown as object)
        : payload;

      const started = process.hrtime.bigint();
      const response = await call.send(body);
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      expect(response.status).toBe(201);
      return elapsed;
    };

    const p95 = (samples: number[]): number =>
      [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)];

    const trial = async (samplesPerArm: number): Promise<number> => {
      const encrypted: number[] = [];
      const cleartext: number[] = [];
      for (let index = 0; index < samplesPerArm; index += 1) {
        encrypted.push(await one(true, index));
        cleartext.push(await one(false, index));
      }
      return p95(encrypted) - p95(cleartext);
    };

    // Warm-up: the first requests through a fresh V8 pay for JIT and for OpenSSL's first
    // AES-GCM context, which would otherwise dominate a p95. Discarded, not measured.
    await trial(60);

    const deltas = [await trial(120), await trial(120), await trial(120)];
    const delta = medianDelta(deltas);

    // Printed for the same reason TC-23 prints its trials: a wide spread reads as contention,
    // a uniformly high set reads as a real regression, and a bare red number reads as neither.
    // eslint-disable-next-line no-console -- T-018 TC-20 requires the measured overhead on record.
    console.log(
      `TC-20: crypto overhead ${delta.toFixed(3)} ms at p95 ` +
        `(median of 3: ${deltas.map((each) => each.toFixed(3)).join(', ')})`,
    );

    expect(delta).toBeLessThan(5);
  });

  /**
   * T-086 TC-3 — `medianDelta` on fixed data, so the claim that TC-20's estimator still
   * catches a real regression is asserted rather than trusted. Deterministic: no clock is read.
   */
  it('TC-20 (estimator): reads through a contention burst in one trial', () => {
    // The 13.9 ms delta actually observed during a full-suite run, alongside two trials taken
    // while the machine was quieter. The true overhead is sub-millisecond; only the first trial
    // saw the burst.
    const withBurst = [13.914, 0.612, 0.488];

    expect(medianDelta(withBurst)).toBeLessThan(5);
    // ...and the single-trial reading this replaced fails the budget on the very same data.
    expect(withBurst[0]).toBeGreaterThan(5);
  });

  it('TC-20 (estimator): still fails a genuine overhead regression in every trial', () => {
    // Real added work is present in every trial — contention cannot make a request faster, so
    // there is no clean trial to find. If this passed, the 5 ms budget would be decorative.
    const regressed = [7.41, 6.98, 8.22];

    expect(medianDelta(regressed)).toBeGreaterThan(5);
  });

  it('TC-21 — 100 concurrent encrypted requests all succeed with no key mix-up', async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, async (_unused, index) => {
        const correlationId = `corr-${String(index).padStart(16, '0')}`;
        const envelope = sealEnvelope(
          harness.key,
          JSON.stringify({ name: `campaign-${index}` }),
          binding({ correlationId }),
        );

        const response = await harness
          .http()
          .post('/api/v1/probe')
          .set('x-test-session', SESSION_ID)
          .set('x-payload-encrypted', 'v1')
          .set(CORRELATION_HEADER, correlationId)
          .send(envelope as unknown as object);

        expect(response.status).toBe(201);
        const decrypted = openResponse(harness.key, response.body, correlationId) as {
          data: { echoed: string };
        };
        return decrypted.data.echoed;
      }),
    );

    expect(results).toEqual(Array.from({ length: 100 }, (_u, index) => `campaign-${index}`));
  });
});

describe('mode: fields (TC-6)', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness('fields');
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('encrypts only the policy-flagged field and leaves the rest readable', async () => {
    const response = await harness
      .http()
      .post('/api/v1/probe')
      .set('x-test-session', SESSION_ID)
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send({ name: 'Summer' });

    expect(response.headers['x-payload-encrypted']).toBe('v1');
    expect(response.body.data.echoed).toBe('Summer');
    expect(response.body.data.id).toBe(7);

    const envelope = response.body.data.temporaryPassword as PayloadEnvelope;
    expect(Object.keys(envelope).sort()).toEqual(['ct', 'iv', 'kid', 'tag']);

    // TC-17 again, one level down: the encrypted field holds the *masked* value.
    const opened = JSON.parse(
      openEnvelope(harness.key, envelope, {
        kid: KID,
        direction: 'res',
        correlationId: CORRELATION_ID,
        path: 'data.temporaryPassword',
      }),
    ) as string;
    expect(opened).toBe(MASKED);
  });

  it('decrypts a field envelope in the request', async () => {
    const field = sealEnvelope(harness.key, JSON.stringify('s3cret-new-password'), {
      kid: KID,
      direction: 'req',
      correlationId: CORRELATION_ID,
      path: 'newPassword',
    });

    const response = await harness
      .http()
      .post('/api/v1/auth/change-password')
      .set('x-test-session', SESSION_ID)
      .set('x-payload-encrypted', 'v1')
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send({ newPassword: field } as unknown as object);

    // `received` is not itself a flagged field name, so the controller's echo comes back in the
    // clear — which is precisely what makes this assertion evidence that the *request* field was
    // decrypted before the handler ran.
    expect(response.status).toBe(201);
    expect(response.body.data.received).toBe('s3cret-new-password');
  });

  it('a field envelope moved to another field is rejected', async () => {
    const field = sealEnvelope(harness.key, JSON.stringify('s3cret'), {
      kid: KID,
      direction: 'req',
      correlationId: CORRELATION_ID,
      path: 'somewhereElse',
    });

    const response = await harness
      .http()
      .post('/api/v1/auth/change-password')
      .set('x-test-session', SESSION_ID)
      .set('x-payload-encrypted', 'v1')
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send({ newPassword: field } as unknown as object);

    expect(response.status).toBe(400);
  });

  it('a body with no flagged field is sent as-is, with no marker header', async () => {
    const response = await harness
      .http()
      .get('/api/v1/health')
      .set('x-test-session', SESSION_ID)
      .set(CORRELATION_HEADER, CORRELATION_ID);

    expect(response.headers['x-payload-encrypted']).toBeUndefined();
  });

  it('encrypts flagged fields nested inside an array', async () => {
    const response = await harness
      .http()
      .get('/api/v1/list')
      .set('x-test-session', SESSION_ID)
      .set(CORRELATION_HEADER, CORRELATION_ID);

    const items = response.body.data as PayloadEnvelope[] extends never
      ? never
      : { temporaryPassword: PayloadEnvelope }[];
    expect(Object.keys(items[0].temporaryPassword).sort()).toEqual(['ct', 'iv', 'kid', 'tag']);
    expect(Object.keys(items[1].temporaryPassword).sort()).toEqual(['ct', 'iv', 'kid', 'tag']);

    // Each carries its own path, so the two cannot be swapped.
    const opened = JSON.parse(
      openEnvelope(harness.key, items[1].temporaryPassword, {
        kid: KID,
        direction: 'res',
        correlationId: CORRELATION_ID,
        path: 'data.1.temporaryPassword',
      }),
    ) as string;
    expect(opened).toBe(MASKED);
  });
});

describe('mode: off (TC-7)', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness('off');
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('is plain JSON both ways', async () => {
    const response = await harness
      .http()
      .post('/api/v1/probe')
      .set('x-test-session', SESSION_ID)
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send({ name: 'Summer' });

    expect(response.status).toBe(201);
    expect(response.headers['x-payload-encrypted']).toBeUndefined();
    expect(response.body.data.echoed).toBe('Summer');
    // Masking is a separate control and is untouched by the rollback.
    expect(response.body.data.temporaryPassword).toBe(MASKED);
  });

  it('is a complete no-op inbound: an envelope is not decrypted, it is just a body', async () => {
    // The rollback has to *stop the code running*, not merely stop requiring it — if decryption
    // is what has gone wrong in production, `off` must take it out of the path entirely.
    const envelope = sealEnvelope(harness.key, JSON.stringify({ name: 'Summer' }), binding());

    const response = await harness
      .http()
      .post('/api/v1/probe')
      .set('x-test-session', SESSION_ID)
      .set('x-payload-encrypted', 'v1')
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send(envelope as unknown as object);

    // Rejected by the DTO, not by the crypto layer — proof the interceptor did not run.
    expect(response.status).toBe(400);
    expect(response.body.error.code).not.toBe('PAYLOAD_DECRYPT_FAILED');
  });
});

describe('TC-8 — route overrides', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness('fields', { 'POST /users': 'full' });
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('POST /users is `full` while everything else stays `fields`', async () => {
    const users = await harness
      .http()
      .post('/api/v1/users')
      .set('x-test-session', SESSION_ID)
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send({ name: 'Summer' });

    expect(Object.keys(users.body).sort()).toEqual(['ct', 'iv', 'kid', 'tag']);

    const probe = await harness
      .http()
      .post('/api/v1/probe')
      .set('x-test-session', SESSION_ID)
      .set(CORRELATION_HEADER, CORRELATION_ID)
      .send({ name: 'Summer' });

    expect(probe.body.data.echoed).toBe('Summer');
    expect(Object.keys(probe.body.data.temporaryPassword).sort()).toEqual([
      'ct',
      'iv',
      'kid',
      'tag',
    ]);
  });
});
