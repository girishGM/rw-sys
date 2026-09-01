import type { Request, Response } from 'express';
import { CorrelationContextMiddleware } from './correlation-context.middleware';
import { CorrelationContextService } from './correlation-context.service';
import type { StructuredLoggerService } from './structured-logger.service';

function fakeLogger(): StructuredLoggerService {
  return { log: jest.fn() } as unknown as StructuredLoggerService;
}

function fakeRequest(headers: Record<string, string> = {}): Request {
  return { headers, method: 'GET', path: '/api/v1/promo-code-configs' } as unknown as Request;
}

function fakeResponse(): Response & { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
  } as unknown as Response & { headers: Record<string, string> };
}

describe('CorrelationContextMiddleware', () => {
  let correlationContext: CorrelationContextService;
  let middleware: CorrelationContextMiddleware;

  beforeEach(() => {
    correlationContext = new CorrelationContextService();
    middleware = new CorrelationContextMiddleware(correlationContext, fakeLogger());
  });

  it('mints a fresh correlationId when the request has none, and makes it visible to next()', () => {
    const req = fakeRequest();
    const res = fakeResponse();
    let observedDuringNext: string | undefined;

    middleware.use(req, res, () => {
      observedDuringNext = correlationContext.getCorrelationId();
    });

    expect(observedDuringNext).toBeDefined();
    expect(res.headers['x-correlation-id']).toBe(observedDuringNext);
  });

  it('reuses an inbound x-correlation-id header instead of minting a new one', () => {
    const req = fakeRequest({ 'x-correlation-id': 'caller-supplied-id' });
    const res = fakeResponse();
    let observed: string | undefined;

    middleware.use(req, res, () => {
      observed = correlationContext.getCorrelationId();
    });

    expect(observed).toBe('caller-supplied-id');
    expect(res.headers['x-correlation-id']).toBe('caller-supplied-id');
  });

  it('tags the context with transport HTTP and the method+path as rpc', () => {
    const req = fakeRequest();
    const res = fakeResponse();
    let context: ReturnType<CorrelationContextService['getCurrent']>;

    middleware.use(req, res, () => {
      context = correlationContext.getCurrent();
    });

    expect(context?.transport).toBe('HTTP');
    expect(context?.rpc).toBe('GET /api/v1/promo-code-configs');
  });
});
