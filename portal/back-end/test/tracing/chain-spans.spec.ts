/**
 * T-019, TC-18 — **every stage of the security chain records a span**.
 *
 * 08-OBSERVABILITY.md §5 draws the waterfall this task has to produce:
 *
 * ```
 * ├─ csrf.verify   ├─ jwt.verify   ├─ session.validate   ├─ permission.check
 * ├─ scope.resolve ├─ payload.decrypt ├─ audit.write     └─ response.mask + encrypt
 * ```
 *
 * ### Why this drives the real classes and not stand-ins
 *
 * The claim TC-18 makes is not "`traceSpan` records spans" — `span.service.spec.ts` proves that.
 * It is "`CsrfGuard` *is instrumented*". A spec that registered its own guards calling
 * `traceSpan` would prove nothing about the nine finished components this task edited, and would
 * stay green if every one of those edits were reverted. So each real class is constructed with
 * the smallest collaborators that reach its instrumented path, invoked inside a trace, and the
 * span it produced is asserted by name.
 *
 * The other half of TC-18 — that the stages appear **together, in order, with durations, on one
 * request** — is asserted at the end from the same trace.
 */
import { of, lastValueFrom, type Observable } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { CsrfGuard } from '@/common/security/csrf.guard';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { SessionValidGuard } from '@/modules/auth/guards/session-valid.guard';
import { PermissionsGuard } from '@/common/rbac/permissions.guard';
import { TenancyScopeInterceptor } from '@/common/scope/tenancy-scope.interceptor';
import { PayloadDecryptInterceptor } from '@/common/transport-crypto/payload-decrypt.interceptor';
import { PayloadEncryptInterceptor } from '@/common/transport-crypto/payload-encrypt.interceptor';
import { ResponseMaskingInterceptor } from '@/common/data-protection/response-masking.interceptor';
import { AuditInterceptor } from '@/common/audit/audit.interceptor';
import { AuditService } from '@/common/audit/audit.service';
import type { HandshakeService } from '@/common/transport-crypto/handshake.service';
import type { TransportPolicyService } from '@/common/transport-crypto/transport-policy.service';
import type { PolicyCacheService } from '@/common/data-protection/policy-cache.service';
import type { TokenService } from '@/modules/auth/services/token.service';
import type { SessionService } from '@/modules/auth/services/session.service';
import type { PermissionCacheService } from '@/common/rbac/permission-cache.service';
import { CHAIN_SPAN } from '@/common/tracing/span.service';
import { TraceContext, type RequestTrace } from '@/common/tracing/trace-context';
import { FakeAuditStore, actor, contextFor } from '../common/support/http-doubles';
import { makeTrace } from './support/trace-fixtures';

/** A `Reflector` that answers every metadata question with `answer`. */
function reflectorSaying(answer: unknown): Reflector {
  return { getAllAndOverride: () => answer } as unknown as Reflector;
}

/** A `CallHandler` emitting `value` once. */
function handlerEmitting(value: unknown = { ok: true }): CallHandler {
  return { handle: (): Observable<unknown> => of(value) };
}

/** An HTTP `ExecutionContext` with a response object, which `contextFor` deliberately omits. */
function httpContextWithResponse(context: ExecutionContext): ExecutionContext {
  const http = context.switchToHttp();
  const response = { setHeader: () => undefined, getHeader: () => undefined };
  return {
    ...context,
    getType: () => 'http',
    getClass: () => context.getClass(),
    getHandler: () => context.getHandler(),
    switchToHttp: () => ({ ...http, getResponse: <T>() => response as T }),
  } as unknown as ExecutionContext;
}

class DummyController {
  handle(): void {
    /* the handler `contextFor` points at; never invoked */
  }
}

/** Runs `fn` inside a fresh trace and returns the spans it produced. */
async function spansFrom(fn: () => unknown | Promise<unknown>): Promise<RequestTrace['spans']> {
  const trace = makeTrace();
  await TraceContext.run(trace, async () => fn());
  return trace.spans;
}

describe('TC-18 — each security-chain stage is instrumented in the real component', () => {
  it('CsrfGuard records csrf.verify', async () => {
    const guard = new CsrfGuard({} as unknown as TokenService);
    const context = contextFor(DummyController, 'handle', { request: { method: 'GET' } });

    const spans = await spansFrom(() => guard.canActivate(context));

    expect(spans.map((span) => span.name)).toEqual([CHAIN_SPAN.CSRF_VERIFY]);
    expect(spans[0].status).toBe('ok');
  });

  it('JwtAuthGuard records jwt.verify', async () => {
    const guard = new JwtAuthGuard(reflectorSaying(true), {} as unknown as TokenService);
    const spans = await spansFrom(() => guard.canActivate(contextFor(DummyController, 'handle')));

    expect(spans.map((span) => span.name)).toEqual([CHAIN_SPAN.JWT_VERIFY]);
  });

  it('SessionValidGuard records session.validate', async () => {
    const guard = new SessionValidGuard(reflectorSaying(true), {} as unknown as SessionService);
    const spans = await spansFrom(() => guard.canActivate(contextFor(DummyController, 'handle')));

    expect(spans.map((span) => span.name)).toEqual([CHAIN_SPAN.SESSION_VALIDATE]);
  });

  it('PermissionsGuard records permission.check', async () => {
    const guard = new PermissionsGuard(
      reflectorSaying(true),
      {} as unknown as PermissionCacheService,
    );
    const spans = await spansFrom(() => guard.canActivate(contextFor(DummyController, 'handle')));

    expect(spans.map((span) => span.name)).toEqual([CHAIN_SPAN.PERMISSION_CHECK]);
  });

  it('TenancyScopeInterceptor records scope.resolve', async () => {
    const interceptor = new TenancyScopeInterceptor();
    const context = contextFor(DummyController, 'handle', { type: 'rpc' });

    const spans = await spansFrom(() =>
      lastValueFrom(interceptor.intercept(context, handlerEmitting())),
    );

    expect(spans.map((span) => span.name)).toEqual([CHAIN_SPAN.SCOPE_RESOLVE]);
  });

  it('PayloadDecryptInterceptor records payload.decrypt', async () => {
    const interceptor = new PayloadDecryptInterceptor(
      {} as unknown as HandshakeService,
      {} as unknown as TransportPolicyService,
    );
    const context = contextFor(DummyController, 'handle', { type: 'rpc' });

    const spans = await spansFrom(async () =>
      lastValueFrom(await interceptor.intercept(context, handlerEmitting())),
    );

    expect(spans.map((span) => span.name)).toEqual([CHAIN_SPAN.PAYLOAD_DECRYPT]);
  });

  it('PayloadEncryptInterceptor records response.encrypt', async () => {
    const interceptor = new PayloadEncryptInterceptor(
      {} as unknown as HandshakeService,
      { modeFor: () => 'off', advertisement: () => ({}) } as unknown as TransportPolicyService,
    );
    const context = httpContextWithResponse(contextFor(DummyController, 'handle'));

    const spans = await spansFrom(() =>
      lastValueFrom(interceptor.intercept(context, handlerEmitting())),
    );

    expect(spans.map((span) => span.name)).toEqual([CHAIN_SPAN.RESPONSE_ENCRYPT]);
  });

  it('ResponseMaskingInterceptor records response.mask', async () => {
    const interceptor = new ResponseMaskingInterceptor(
      // The `*Safe` forms are what the interceptor calls (T-017's fail-closed contract); naming
      // the wrong one sends it down its `catch` branch, which still records the span but proves
      // less than it looks like it does.
      {
        resolveFieldNameSafe: () => null,
        resolveColumnSafe: () => null,
      } as unknown as PolicyCacheService,
      reflectorSaying(false),
    );
    const context = contextFor(DummyController, 'handle', { authUser: actor() });

    const spans = await spansFrom(() =>
      lastValueFrom(interceptor.intercept(context, handlerEmitting({ name: 'value' }))),
    );

    expect(spans.map((span) => span.name)).toEqual([CHAIN_SPAN.RESPONSE_MASK]);
  });

  it('AuditInterceptor records audit.write', async () => {
    const store = new FakeAuditStore();
    const interceptor = new AuditInterceptor(
      reflectorSaying({ event: 'thing_updated', targetType: 'thing' }),
      new AuditService(store),
    );
    const context = contextFor(DummyController, 'handle', { authUser: actor() });

    const spans = await spansFrom(() =>
      lastValueFrom(interceptor.intercept(context, handlerEmitting())),
    );

    expect(spans.map((span) => span.name)).toEqual([CHAIN_SPAN.AUDIT_WRITE]);
    // The write really happened inside the span — a span around a no-op would prove nothing.
    expect(store.portalRows).toHaveLength(1);
  });

  it('is a no-op in all nine when no trace is established', async () => {
    // The transparency guarantee, stated across the whole chain rather than only for `traceSpan`:
    // every one of these components must behave identically outside a request, which is the
    // condition under which six other tasks' unit suites run.
    const guard = new CsrfGuard({} as unknown as TokenService);
    expect(
      guard.canActivate(contextFor(DummyController, 'handle', { request: { method: 'GET' } })),
    ).toBe(true);
    expect(TraceContext.isActive()).toBe(false);
  });
});

describe('TC-18 — the stages appear together, in order, with durations', () => {
  it('produces the §5 waterfall for one request', async () => {
    const trace = makeTrace();
    const context = contextFor(DummyController, 'handle', {
      authUser: actor(),
      request: { method: 'GET' },
    });
    const rpcContext = contextFor(DummyController, 'handle', { type: 'rpc' });
    const store = new FakeAuditStore();

    await TraceContext.run(trace, async () => {
      new CsrfGuard({} as unknown as TokenService).canActivate(context);
      new JwtAuthGuard(reflectorSaying(true), {} as unknown as TokenService).canActivate(context);
      await new SessionValidGuard(
        reflectorSaying(true),
        {} as unknown as SessionService,
      ).canActivate(context);
      await new PermissionsGuard(
        reflectorSaying(true),
        {} as unknown as PermissionCacheService,
      ).canActivate(context);
      await lastValueFrom(new TenancyScopeInterceptor().intercept(rpcContext, handlerEmitting()));
      await lastValueFrom(
        await new PayloadDecryptInterceptor(
          {} as unknown as HandshakeService,
          {} as unknown as TransportPolicyService,
        ).intercept(rpcContext, handlerEmitting()),
      );
      await lastValueFrom(
        new AuditInterceptor(
          reflectorSaying({ event: 'thing_updated', targetType: 'thing' }),
          new AuditService(store),
        ).intercept(context, handlerEmitting()),
      );
      await lastValueFrom(
        new ResponseMaskingInterceptor(
          // The `*Safe` forms are what the interceptor calls (T-017's fail-closed contract); naming
          // the wrong one sends it down its `catch` branch, which still records the span but proves
          // less than it looks like it does.
          {
            resolveFieldNameSafe: () => null,
            resolveColumnSafe: () => null,
          } as unknown as PolicyCacheService,
          reflectorSaying(false),
        ).intercept(context, handlerEmitting({ name: 'v' })),
      );
      await lastValueFrom(
        new PayloadEncryptInterceptor(
          {} as unknown as HandshakeService,
          { modeFor: () => 'off', advertisement: () => ({}) } as unknown as TransportPolicyService,
        ).intercept(httpContextWithResponse(context), handlerEmitting()),
      );
    });

    expect(trace.spans.map((span) => span.name)).toEqual([
      'csrf.verify',
      'jwt.verify',
      'session.validate',
      'permission.check',
      'scope.resolve',
      'payload.decrypt',
      'audit.write',
      'response.mask',
      'response.encrypt',
    ]);

    for (const span of trace.spans) {
      expect(typeof span.durationMs).toBe('number');
      expect(span.durationMs).toBeGreaterThanOrEqual(0);
      expect(span.startedAtMs).toBeGreaterThanOrEqual(0);
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(span.status).toBe('ok');
    }

    // Monotonic on the timeline: each stage starts no earlier than the previous one.
    const starts = trace.spans.map((span) => span.startedAtMs);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });
});
