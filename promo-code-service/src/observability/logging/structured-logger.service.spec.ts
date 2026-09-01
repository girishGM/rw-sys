import { CorrelationContextService } from './correlation-context.service';
import { StructuredLoggerService } from './structured-logger.service';

function captureStdout(): { restore: () => void; lines(): unknown[] } {
  const written: string[] = [];
  const spy = jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    written.push(chunk);
    return true;
  }) as typeof process.stdout.write);
  return {
    restore: () => spy.mockRestore(),
    lines: () => written.map((line) => JSON.parse(line)),
  };
}

function captureStderr(): { restore: () => void; lines(): unknown[] } {
  const written: string[] = [];
  const spy = jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    written.push(chunk);
    return true;
  }) as typeof process.stderr.write);
  return {
    restore: () => spy.mockRestore(),
    lines: () => written.map((line) => JSON.parse(line)),
  };
}

describe('StructuredLoggerService', () => {
  let correlationContext: CorrelationContextService;
  let logger: StructuredLoggerService;

  beforeEach(() => {
    correlationContext = new CorrelationContextService();
    logger = new StructuredLoggerService(correlationContext);
  });

  // TC-3: log line JSON shape.
  it('emits a single valid-JSON line per call, with the documented field schema', () => {
    const capture = captureStdout();
    logger.log('hello world', 'SomeContext');
    capture.restore();

    const [entry] = capture.lines() as Array<Record<string, unknown>>;
    expect(entry.message).toBe('hello world');
    expect(entry.level).toBe('log');
    expect(entry.context).toBe('SomeContext');
    expect(typeof entry.timestamp).toBe('string');
    expect(new Date(entry.timestamp as string).toString()).not.toBe('Invalid Date');
  });

  it('never writes through console.log/warn/error — only process.stdout/stderr', () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    const capture = captureStdout();

    logger.log('message', 'Ctx');

    expect(consoleSpy).not.toHaveBeenCalled();
    capture.restore();
    consoleSpy.mockRestore();
  });

  it('routes error/fatal to stderr, everything else to stdout', () => {
    const out = captureStdout();
    const err = captureStderr();

    logger.log('a log line', 'Ctx');
    logger.warn('a warn line', 'Ctx');
    logger.error('an error line', 'Ctx');

    err.restore();
    out.restore();

    expect(out.lines()).toHaveLength(2);
    expect(err.lines()).toHaveLength(1);
    expect((err.lines()[0] as Record<string, unknown>).level).toBe('error');
  });

  // TC-1/TC-2/TC-10: the actual point of this task — every log line for one request's
  // lifecycle carries the same correlationId, including a FAILED/GENERATION_EXHAUSTED outcome.
  it('attaches the current correlationId/tenantId/transport when inside a CorrelationContextService.run()', () => {
    const capture = captureStdout();

    correlationContext.run(
      { correlationId: 'corr-xyz', tenantId: 'tenant-1', transport: 'KAFKA' },
      () => {
        logger.log('binding resolved', 'CampaignBindingService');
        logger.warn(
          'GENERATION_EXHAUSTED for correlationId "corr-xyz"',
          'PromoCodeGenerationService',
        );
      },
    );
    capture.restore();

    const lines = capture.lines() as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.correlationId).toBe('corr-xyz');
      expect(line.tenantId).toBe('tenant-1');
      expect(line.transport).toBe('KAFKA');
    }
  });

  it('omits correlationId entirely when logged outside any request context', () => {
    const capture = captureStdout();
    logger.log('no context here');
    capture.restore();

    const [entry] = capture.lines() as Array<Record<string, unknown>>;
    expect(entry).not.toHaveProperty('correlationId');
  });

  it('captures a stack string on error() when Nest passes one as a positional param', () => {
    const capture = captureStderr();
    logger.error('boom', 'a fake stack trace', 'SomeContext');
    capture.restore();

    const [entry] = capture.lines() as Array<Record<string, unknown>>;
    expect(entry.context).toBe('SomeContext');
    expect(entry.stack).toBe('a fake stack trace');
  });
});
