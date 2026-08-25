/**
 * T-018 — the interceptor branches that cannot be provoked over HTTP.
 *
 * `transport-crypto.http.spec.ts` is the authority on behaviour, because the ordering *is* the
 * behaviour. What is left over is a short list of shapes a real HTTP request cannot produce: a
 * non-HTTP execution context (T-047's gRPC port, the scheduler), a handler returning a stream, a
 * body nested past the depth bound. Each of those is a branch that decides whether something
 * leaves the process encrypted, so each gets a test.
 */
import { firstValueFrom, of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { CORRELATION_HEADER } from '@/common/errors/trace-id';
import { HandshakeService } from '@/common/transport-crypto/handshake.service';
import {
  MAX_PAYLOAD_DEPTH,
  PayloadDecryptInterceptor,
} from '@/common/transport-crypto/payload-decrypt.interceptor';
import {
  isEncryptableBody,
  PayloadEncryptInterceptor,
} from '@/common/transport-crypto/payload-encrypt.interceptor';
import { TransportPolicyService } from '@/common/transport-crypto/transport-policy.service';
import {
  sessionKid,
  TRANSPORT_POLICY_HEADER,
  TRANSPORT_PUBLIC_KEY_HEADER,
} from '@/common/transport-crypto/transport-crypto.constants';
import { sealEnvelope } from '@/common/transport-crypto/transport-envelope';
import { buildHandshake, SESSION_ID } from './support/harness';
import { createECDH } from 'node:crypto';

const KID = sessionKid(SESSION_ID);
const CORRELATION_ID = 'corr-0123456789abcdef';

/** A `TransportPolicyService` double: fixed mode, one flagged field, one advertisement. */
function transport(mode: 'off' | 'fields' | 'full'): TransportPolicyService {
  return {
    modeFor: () => mode,
    isPayloadEncryptField: (name: string) => name === 'secret',
    advertisement: () => ({ mode, routeOverrides: {}, fields: ['secret'] }),
  } as unknown as TransportPolicyService;
}

function httpContext(
  request: unknown,
  response: unknown = { setHeader: jest.fn() },
): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
}

function rpcContext(): ExecutionContext {
  return { getType: () => 'rpc' } as unknown as ExecutionContext;
}

function handler(body: unknown): CallHandler {
  return { handle: () => of(body) };
}

describe('PayloadDecryptInterceptor', () => {
  it('leaves a non-HTTP context completely alone', async () => {
    const interceptor = new PayloadDecryptInterceptor(
      {} as unknown as HandshakeService,
      transport('full'),
    );

    const observable = await interceptor.intercept(rpcContext(), handler('rpc payload'));
    await expect(firstValueFrom(observable)).resolves.toBe('rpc payload');
  });

  it('warms the key cache on an unencrypted request, so the response side needs no second read', async () => {
    const { handshake, store } = await buildHandshake();
    await handshake.establish(
      SESSION_ID,
      createECDH('prime256v1').generateKeys().toString('base64'),
    );
    const spy = jest.spyOn(store, 'find');

    const interceptor = new PayloadDecryptInterceptor(handshake, transport('full'));
    const request = {
      method: 'POST',
      path: '/api/v1/probe',
      headers: {},
      authUser: { sessionId: SESSION_ID },
    };

    await interceptor.intercept(httpContext(request), handler(null));
    // The second read comes from the request-scoped memo, not the store.
    await handshake.keyForRequest(request as never);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('stops descending past the depth bound rather than walking attacker-supplied JSON forever', async () => {
    const { handshake } = await buildHandshake();
    await handshake.establish(
      SESSION_ID,
      createECDH('prime256v1').generateKeys().toString('base64'),
    );
    const key = (await handshake.keyForSession(SESSION_ID))!;

    // An envelope buried below MAX_PAYLOAD_DEPTH is left as data rather than decrypted. That is
    // the safe direction: the DTO then rejects it, and nothing unbounded ever runs.
    const deep = sealEnvelope(key, '"never reached"', {
      kid: KID,
      direction: 'req',
      correlationId: CORRELATION_ID,
      path: 'x'.repeat(1),
    });
    let body: unknown = deep;
    for (let depth = 0; depth <= MAX_PAYLOAD_DEPTH + 2; depth += 1) body = { nested: body };

    const request = {
      method: 'POST',
      path: '/api/v1/probe',
      headers: { 'x-payload-encrypted': 'v1', [CORRELATION_HEADER]: CORRELATION_ID },
      authUser: { sessionId: SESSION_ID },
      body,
    };

    const interceptor = new PayloadDecryptInterceptor(handshake, transport('full'));
    await interceptor.intercept(httpContext(request), handler(null));

    let walked = request.body as Record<string, unknown>;
    while (walked.nested !== undefined) walked = walked.nested as Record<string, unknown>;
    expect(walked).toEqual(deep);
  });

  it('answers 400 when a field envelope opens to something that is not JSON', async () => {
    const { handshake } = await buildHandshake();
    await handshake.establish(
      SESSION_ID,
      createECDH('prime256v1').generateKeys().toString('base64'),
    );
    const key = (await handshake.keyForSession(SESSION_ID))!;

    // Opens cleanly — the key and AAD are right — but the plaintext is not what this side writes.
    // "We share a key and this payload is broken" gets the same opaque 400 as a tag failure.
    const field = sealEnvelope(key, 'not json at all', {
      kid: KID,
      direction: 'req',
      correlationId: CORRELATION_ID,
      path: 'secret',
    });

    const interceptor = new PayloadDecryptInterceptor(handshake, transport('fields'));
    const request = {
      method: 'POST',
      path: '/api/v1/probe',
      headers: { 'x-payload-encrypted': 'v1', [CORRELATION_HEADER]: CORRELATION_ID },
      authUser: { sessionId: SESSION_ID },
      body: { secret: field },
    };

    await expect(interceptor.intercept(httpContext(request), handler(null))).rejects.toMatchObject({
      status: 400,
      response: { error: { code: 'PAYLOAD_DECRYPT_FAILED' } },
    });
  });

  it('rejects the marker header sent twice, and says so without echoing its value', async () => {
    const { handshake } = await buildHandshake();
    const interceptor = new PayloadDecryptInterceptor(handshake, transport('full'));
    const request = {
      method: 'POST',
      path: '/api/v1/probe',
      // Express yields an array when a header arrives twice. A legitimate client does not do it,
      // and picking one of the two would be guessing which half of a confused request to trust.
      headers: { 'x-payload-encrypted': ['v1', 'v1'] },
      authUser: { sessionId: SESSION_ID },
      body: {},
    };

    await expect(interceptor.intercept(httpContext(request), handler(null))).rejects.toMatchObject({
      status: 400,
    });
  });

  it('leaves scalars and nulls inside a body untouched', async () => {
    const { handshake } = await buildHandshake();
    await handshake.establish(
      SESSION_ID,
      createECDH('prime256v1').generateKeys().toString('base64'),
    );

    const request = {
      method: 'POST',
      path: '/api/v1/probe',
      headers: { 'x-payload-encrypted': 'v1', [CORRELATION_HEADER]: CORRELATION_ID },
      authUser: { sessionId: SESSION_ID },
      body: { a: 1, b: null, c: 'text', d: [1, 'two', null], e: true },
    };

    const interceptor = new PayloadDecryptInterceptor(handshake, transport('fields'));
    await interceptor.intercept(httpContext(request), handler(null));

    expect(request.body).toEqual({ a: 1, b: null, c: 'text', d: [1, 'two', null], e: true });
  });
});

describe('PayloadEncryptInterceptor', () => {
  it('leaves a non-HTTP context completely alone', async () => {
    const interceptor = new PayloadEncryptInterceptor(
      {} as unknown as HandshakeService,
      transport('full'),
    );
    const observable = interceptor.intercept(rpcContext(), handler('rpc payload'));
    await expect(firstValueFrom(observable)).resolves.toBe('rpc payload');
  });

  it('advertises the transport policy on the login response, but only to a client that handshook', async () => {
    const { handshake } = await buildHandshake();
    const interceptor = new PayloadEncryptInterceptor(handshake, transport('fields'));
    const response = { setHeader: jest.fn() };

    await firstValueFrom(
      interceptor.intercept(
        httpContext(
          {
            method: 'POST',
            path: '/api/v1/auth/login',
            headers: { [TRANSPORT_PUBLIC_KEY_HEADER]: 'a-public-key' },
          },
          response,
        ),
        handler({ data: { role: 'super_admin' } }),
      ),
    );

    expect(response.setHeader).toHaveBeenCalledWith(
      TRANSPORT_POLICY_HEADER,
      JSON.stringify({ mode: 'fields', routeOverrides: {}, fields: ['secret'] }),
    );
  });

  it('does not advertise to an ordinary login that offered no public key', async () => {
    const { handshake } = await buildHandshake();
    const interceptor = new PayloadEncryptInterceptor(handshake, transport('fields'));
    const response = { setHeader: jest.fn() };

    await firstValueFrom(
      interceptor.intercept(
        httpContext({ method: 'POST', path: '/api/v1/auth/login', headers: {} }, response),
        handler({ data: {} }),
      ),
    );

    expect(response.setHeader).not.toHaveBeenCalled();
  });

  it('passes a body through when the request has no authenticated session', async () => {
    const { handshake } = await buildHandshake();
    const interceptor = new PayloadEncryptInterceptor(handshake, transport('full'));

    const body = { data: { public: true } };
    await expect(
      firstValueFrom(
        interceptor.intercept(
          httpContext({ method: 'GET', path: '/api/v1/probe', headers: {} }),
          handler(body),
        ),
      ),
    ).resolves.toBe(body);
  });

  it('passes a 204 (no body) through rather than encrypting `undefined`', async () => {
    const { handshake } = await buildHandshake();
    await handshake.establish(
      SESSION_ID,
      createECDH('prime256v1').generateKeys().toString('base64'),
    );
    const interceptor = new PayloadEncryptInterceptor(handshake, transport('full'));
    const response = { setHeader: jest.fn() };

    await expect(
      firstValueFrom(
        interceptor.intercept(
          httpContext(
            {
              method: 'POST',
              path: '/api/v1/auth/logout',
              headers: { [CORRELATION_HEADER]: CORRELATION_ID },
              authUser: { sessionId: SESSION_ID },
            },
            response,
          ),
          handler(undefined),
        ),
      ),
    ).resolves.toBeUndefined();

    // No marker header on a body-less response — a client that saw one would try to decrypt air.
    expect(response.setHeader).not.toHaveBeenCalled();
  });

  it('stops descending past the depth bound', async () => {
    const { handshake } = await buildHandshake();
    await handshake.establish(
      SESSION_ID,
      createECDH('prime256v1').generateKeys().toString('base64'),
    );
    const interceptor = new PayloadEncryptInterceptor(handshake, transport('fields'));

    let body: unknown = { secret: 'too deep to reach' };
    for (let depth = 0; depth <= MAX_PAYLOAD_DEPTH + 2; depth += 1) body = { nested: body };

    const result = await firstValueFrom(
      interceptor.intercept(
        httpContext({
          method: 'GET',
          path: '/api/v1/probe',
          headers: { [CORRELATION_HEADER]: CORRELATION_ID },
          authUser: { sessionId: SESSION_ID },
        }),
        handler(body),
      ),
    );

    // Left as-is rather than encrypted. The bound protects against unbounded recursion; a payload
    // this deep is not something this API produces, so nothing legitimate is affected.
    let walked = result as Record<string, unknown>;
    while (walked.nested !== undefined) walked = walked.nested as Record<string, unknown>;
    expect(walked).toEqual({ secret: 'too deep to reach' });
  });

  it('does not encrypt a Date or an undefined field value inside a `fields` body', async () => {
    const { handshake } = await buildHandshake();
    await handshake.establish(
      SESSION_ID,
      createECDH('prime256v1').generateKeys().toString('base64'),
    );
    const interceptor = new PayloadEncryptInterceptor(handshake, transport('fields'));

    const issuedAt = new Date('2026-08-18T00:00:00.000Z');
    const result = (await firstValueFrom(
      interceptor.intercept(
        httpContext({
          method: 'GET',
          path: '/api/v1/probe',
          headers: { [CORRELATION_HEADER]: CORRELATION_ID },
          authUser: { sessionId: SESSION_ID },
        }),
        handler({ issuedAt, secret: undefined, nested: { secret: 'x' } }),
      ),
    )) as Record<string, unknown>;

    expect(result.issuedAt).toBe(issuedAt);
    // `undefined` is "not set", not "hidden": encrypting it would invent a value.
    expect(result.secret).toBeUndefined();
    expect(Object.keys(result.nested as object)).toEqual(['secret']);
  });
});

describe('isEncryptableBody', () => {
  it.each([
    ['a plain object', { data: 1 }, true],
    ['an array', [1, 2], true],
    [
      'a class instance (a route exempt from response masking still returns one)',
      new (class {
        value = 1;
      })(),
      true,
    ],
    ['null (a 204)', null, false],
    ['undefined (a 204)', undefined, false],
    ['a string', 'plain text', false],
    ['a number', 7, false],
    ['a Buffer', Buffer.from('bytes'), false],
    ['a Date', new Date(), false],
    ['a stream', { pipe: () => undefined }, false],
    ['a StreamableFile', { getStream: () => undefined }, false],
  ])('%s → %s', (_label, body, expected) => {
    expect(isEncryptableBody(body)).toBe(expected);
  });
});
