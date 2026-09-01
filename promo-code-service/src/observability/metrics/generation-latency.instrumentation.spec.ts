import { GenerationLatencyInstrumentation } from './generation-latency.instrumentation';
import type { PromoCodeGenerationService } from '../../modules/generation/promo-code-generation.service';
import type { MetricsService } from './metrics.service';
import type { StructuredLoggerService } from '../logging/structured-logger.service';
import type { GenerationResult } from '../../modules/generation/generation-result.types';

function fakeLogger(): StructuredLoggerService {
  return { debug: jest.fn(), warn: jest.fn() } as unknown as StructuredLoggerService;
}

describe('GenerationLatencyInstrumentation', () => {
  it('wraps generateCode(): records latency + increments codes_generated, then returns the original result', async () => {
    const successResult: GenerationResult = {
      status: 'SUCCESS',
      promoCodeId: 'pc-1',
      code: 'ABC123',
      rewardValueType: 'FIXED_AMOUNT',
      rewardValue: '5.00',
      rewardUnit: 'USD',
      expiresAt: null,
      errorCode: null,
      errorMessage: null,
    };

    const generationService = {
      generateCode: jest.fn().mockResolvedValue(successResult),
    } as unknown as PromoCodeGenerationService;

    const metrics = {
      recordGenerationLatency: jest.fn(),
      incrementCodesGenerated: jest.fn(),
    } as unknown as MetricsService;

    const instrumentation = new GenerationLatencyInstrumentation(
      generationService,
      metrics,
      fakeLogger(),
    );
    instrumentation.onModuleInit();

    const result = await generationService.generateCode({ transport: 'KAFKA' });

    expect(result).toBe(successResult);
    expect(metrics.incrementCodesGenerated).toHaveBeenCalledWith('KAFKA', 'SUCCESS');
    expect(metrics.recordGenerationLatency).toHaveBeenCalledWith(expect.any(Number), 'KAFKA');
    const recordedMs = (metrics.recordGenerationLatency as jest.Mock).mock.calls[0][0] as number;
    expect(recordedMs).toBeGreaterThanOrEqual(0);
  });

  it('defaults to GRPC transport labelling when the input has no recognisable transport field', async () => {
    const failureResult: GenerationResult = {
      status: 'FAILED',
      promoCodeId: null,
      code: null,
      rewardValueType: null,
      rewardValue: null,
      rewardUnit: null,
      expiresAt: null,
      errorCode: 'GENERATION_EXHAUSTED',
      errorMessage: 'exhausted',
    };
    const generationService = {
      generateCode: jest.fn().mockResolvedValue(failureResult),
    } as unknown as PromoCodeGenerationService;
    const metrics = {
      recordGenerationLatency: jest.fn(),
      incrementCodesGenerated: jest.fn(),
    } as unknown as MetricsService;

    const instrumentation = new GenerationLatencyInstrumentation(
      generationService,
      metrics,
      fakeLogger(),
    );
    instrumentation.onModuleInit();

    await generationService.generateCode({});

    expect(metrics.incrementCodesGenerated).toHaveBeenCalledWith('GRPC', 'FAILED');
  });

  it('only installs the wrapper once even if onModuleInit() runs twice', async () => {
    const generationService = {
      generateCode: jest.fn().mockResolvedValue({ status: 'SUCCESS' } as GenerationResult),
    } as unknown as PromoCodeGenerationService;
    const metrics = {
      recordGenerationLatency: jest.fn(),
      incrementCodesGenerated: jest.fn(),
    } as unknown as MetricsService;

    const instrumentation = new GenerationLatencyInstrumentation(
      generationService,
      metrics,
      fakeLogger(),
    );
    instrumentation.onModuleInit();
    const wrappedOnce = generationService.generateCode;
    instrumentation.onModuleInit();

    expect(generationService.generateCode).toBe(wrappedOnce);
  });
});
