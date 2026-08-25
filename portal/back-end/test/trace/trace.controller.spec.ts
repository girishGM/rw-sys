/**
 * T-045 — `TraceController`: thin, and `super_admin`-only. The 403/404 behaviour itself is
 * `RolesGuard`'s and `TraceService`'s respectively (asserted in their own suites and in
 * `trace.e2e-spec.ts`); this suite proves the controller declares the right metadata and
 * delegates without adding logic of its own.
 */
import 'reflect-metadata';
import { AUDIT_METADATA } from '@/common/audit/decorators/audit.decorator';
import { ROLES_METADATA_KEY } from '@/common/rbac/rbac.constants';
import { TraceController } from '@/modules/trace/trace.controller';
import type { TraceResponse } from '@reward-portal/shared';
import type { TraceService } from '@/modules/trace/trace.service';

function fakeResponse(): TraceResponse {
  return {
    correlationId: '01J8F3K9QP2M7N',
    summary: {
      correlationId: '01J8F3K9QP2M7N',
      startedAt: null,
      durationMs: null,
      actor: null,
      scope: null,
      route: null,
      status: null,
    },
    spans: [],
    sources: {
      portalAuditLog: 'available',
      domainAudit: 'available',
      logStore: 'not_configured',
      configFetches: 'not_configured',
    },
    auditEvents: [],
    domainAudit: [],
    configFetches: [],
    logLines: null,
    truncated: false,
  };
}

describe('TraceController', () => {
  it('declares @Roles(super_admin) at the class level, and nothing wider', () => {
    const roles = Reflect.getMetadata(ROLES_METADATA_KEY, TraceController) as string[];
    expect(roles).toEqual(['super_admin']);
  });

  it('audits the read (trace_viewed → portal_audit_log)', () => {
    const options = Reflect.getMetadata(AUDIT_METADATA, TraceController.prototype.getTrace) as {
      event: string;
      targetType?: string;
      store?: string;
    };
    expect(options.event).toBe('trace_viewed');
    expect(options.targetType).toBe('trace');
    expect(options.store ?? 'portal').toBe('portal');
  });

  it('delegates the path parameter to TraceService.assemble and wraps the result in {data}', async () => {
    const response = fakeResponse();
    const assemble = jest.fn().mockResolvedValue(response);
    const controller = new TraceController({ assemble } as unknown as TraceService);

    const result = await controller.getTrace('01J8F3K9QP2M7N');

    expect(assemble).toHaveBeenCalledWith('01J8F3K9QP2M7N');
    expect(result).toEqual({ data: response });
  });

  it('does not itself validate or transform the path parameter — that is TraceService.assemble’s job', async () => {
    const assembleError = new Error('rejected by the service');
    const assemble = jest.fn().mockRejectedValue(assembleError);
    const controller = new TraceController({ assemble } as unknown as TraceService);

    await expect(controller.getTrace('not-even-checked-here')).rejects.toBe(assembleError);
    expect(assemble).toHaveBeenCalledWith('not-even-checked-here');
  });
});
