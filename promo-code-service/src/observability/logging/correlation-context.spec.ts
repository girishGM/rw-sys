import { CorrelationContextService } from './correlation-context.service';

describe('CorrelationContextService', () => {
  let service: CorrelationContextService;

  beforeEach(() => {
    service = new CorrelationContextService();
  });

  it('returns undefined outside of any run() call', () => {
    expect(service.getCurrent()).toBeUndefined();
    expect(service.getCorrelationId()).toBeUndefined();
  });

  it('makes the context visible inside run() and to nested synchronous calls', () => {
    service.run({ correlationId: 'corr-1', tenantId: 'tenant-1', transport: 'GRPC' }, () => {
      expect(service.getCorrelationId()).toBe('corr-1');
      expect(service.getCurrent()).toEqual({
        correlationId: 'corr-1',
        tenantId: 'tenant-1',
        transport: 'GRPC',
      });
    });
  });

  it('propagates across an async continuation (await) within the same run()', async () => {
    await service.run({ correlationId: 'corr-async' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(service.getCorrelationId()).toBe('corr-async');
    });
  });

  it('is invisible again once run() returns', () => {
    service.run({ correlationId: 'corr-2' }, () => undefined);
    expect(service.getCorrelationId()).toBeUndefined();
  });

  // The property that actually matters for TC-1/TC-2/TC-10: two "requests" processed with
  // overlapping async timelines never see each other's correlationId.
  it('keeps two concurrently-running contexts fully isolated from each other', async () => {
    const observed: string[] = [];

    async function simulateRequest(correlationId: string, delayMs: number): Promise<void> {
      await service.run({ correlationId }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        observed.push(`${correlationId}:${service.getCorrelationId()}`);
      });
    }

    await Promise.all([simulateRequest('req-a', 10), simulateRequest('req-b', 1)]);

    expect(observed.sort()).toEqual(['req-a:req-a', 'req-b:req-b']);
  });

  it('restores the outer context after a nested run() completes', () => {
    service.run({ correlationId: 'outer' }, () => {
      service.run({ correlationId: 'inner' }, () => {
        expect(service.getCorrelationId()).toBe('inner');
      });
      expect(service.getCorrelationId()).toBe('outer');
    });
  });
});
