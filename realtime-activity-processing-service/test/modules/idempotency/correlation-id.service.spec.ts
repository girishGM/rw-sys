import { CorrelationIdService } from '@/modules/idempotency/correlation-id.service';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('CorrelationIdService.resolve', () => {
  let service: CorrelationIdService;

  beforeEach(() => {
    service = new CorrelationIdService();
  });

  // TC-5: correlationId supplied by caller -> resolved value equals the supplied one.
  it('returns the supplied correlationId verbatim', () => {
    expect(service.resolve('caller-supplied-id-42')).toBe('caller-supplied-id-42');
  });

  // TC-6: correlationId not supplied -> resolved value is a fresh, valid uuid.
  it('generates a fresh, valid uuid when no correlationId is supplied', () => {
    const resolved = service.resolve();
    expect(resolved).toMatch(UUID_V4_PATTERN);
  });

  it('generates a different uuid on each call when no correlationId is supplied', () => {
    const first = service.resolve();
    const second = service.resolve();
    expect(first).not.toBe(second);
  });

  it('generates a fresh uuid when the supplied correlationId is blank or whitespace-only', () => {
    expect(service.resolve('')).toMatch(UUID_V4_PATTERN);
    expect(service.resolve('   ')).toMatch(UUID_V4_PATTERN);
  });
});
