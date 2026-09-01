import type { ConfigService } from '@nestjs/config';
import type { Sequelize } from 'sequelize-typescript';
import type { Config } from '../../config/config.schema';
import { MetricsService } from './metrics.service';
import { KafkaConsumerLagProvider } from './kafka-consumer-lag.provider';
import { StructuredLoggerService } from '../logging/structured-logger.service';
import { CorrelationContextService } from '../logging/correlation-context.service';

jest.mock('./kafka-consumer-lag.provider');

function fakeConfigService(kafkaBrokers = 'localhost:9092'): ConfigService<Config, true> {
  return {
    get: jest.fn().mockReturnValue(kafkaBrokers),
  } as unknown as ConfigService<Config, true>;
}

function fakeSequelize(rows: unknown[]): Sequelize {
  return {
    query: jest.fn().mockResolvedValue(rows),
  } as unknown as Sequelize;
}

describe('MetricsService', () => {
  let logger: StructuredLoggerService;
  let getLagMock: jest.Mock;

  beforeEach(() => {
    logger = new StructuredLoggerService(new CorrelationContextService());
    getLagMock = jest.fn().mockResolvedValue(0);
    (KafkaConsumerLagProvider as jest.Mock).mockImplementation(() => ({
      getLag: getLagMock,
      disconnect: jest.fn(),
    }));
  });

  // TC-7: zero PENDING rows reads as 0 / 0, never an error, never "absent".
  it('reports zero pending count and zero oldest-age when the outbox has no PENDING rows', async () => {
    const sequelize = fakeSequelize([{ pending_count: '0', oldest_pending_age_seconds: null }]);
    const service = new MetricsService(sequelize, fakeConfigService(), logger);

    const text = await service.render();

    expect(text).toContain('promo_code_outbox_pending_count 0');
    expect(text).toContain('promo_code_outbox_oldest_pending_age_seconds 0');
  });

  // TC-6: several PENDING rows present — count and oldest-row age reflected accurately.
  it('reports the real pending count and oldest-row age from the query result', async () => {
    const sequelize = fakeSequelize([{ pending_count: '4', oldest_pending_age_seconds: 137.5 }]);
    const service = new MetricsService(sequelize, fakeConfigService(), logger);

    const text = await service.render();

    expect(text).toContain('promo_code_outbox_pending_count 4');
    expect(text).toContain('promo_code_outbox_oldest_pending_age_seconds 137.5');
  });

  // TC-4: codes_generated_total reflects generated codes.
  it('accumulates codes_generated_total across increments, labelled by transport/outcome', async () => {
    const sequelize = fakeSequelize([{ pending_count: '0', oldest_pending_age_seconds: null }]);
    const service = new MetricsService(sequelize, fakeConfigService(), logger);

    service.incrementCodesGenerated('KAFKA', 'SUCCESS');
    service.incrementCodesGenerated('KAFKA', 'SUCCESS');
    service.incrementCodesGenerated('GRPC', 'FAILED');

    const text = await service.render();

    expect(text).toContain(
      'promo_code_codes_generated_total{transport="KAFKA",outcome="SUCCESS"} 2',
    );
    expect(text).toContain('promo_code_codes_generated_total{transport="GRPC",outcome="FAILED"} 1');
  });

  // TC-5: generation latency for a retry-heavy request reflects the added retry time.
  it('records generation latency observations that grow with a slower (retry-heavy) call', async () => {
    const sequelize = fakeSequelize([{ pending_count: '0', oldest_pending_age_seconds: null }]);
    const service = new MetricsService(sequelize, fakeConfigService(), logger);

    service.recordGenerationLatency(2, 'KAFKA'); // fast, no retries
    service.recordGenerationLatency(420, 'KAFKA'); // slow, simulating collision retries

    const text = await service.render();

    // The slow observation must land in a bucket the fast one doesn't reach.
    expect(text).toContain(
      'promo_code_generation_duration_seconds_bucket{transport="KAFKA",le="0.005"} 1',
    );
    expect(text).toContain(
      'promo_code_generation_duration_seconds_bucket{transport="KAFKA",le="0.5"} 2',
    );
    expect(text).toContain('promo_code_generation_duration_seconds_count{transport="KAFKA"} 2');
  });

  // TC-8/TC-9 at the unit level: the gauge reflects whatever the lag provider reports.
  it('reflects a nonzero Kafka consumer lag from the lag provider', async () => {
    getLagMock.mockResolvedValue(42);
    const sequelize = fakeSequelize([{ pending_count: '0', oldest_pending_age_seconds: null }]);
    const service = new MetricsService(sequelize, fakeConfigService(), logger);

    const text = await service.render();

    expect(text).toContain('promo_code_kafka_consumer_lag 42');
  });

  it('reflects lag returning to zero once the consumer has caught up', async () => {
    getLagMock.mockResolvedValue(0);
    const sequelize = fakeSequelize([{ pending_count: '0', oldest_pending_age_seconds: null }]);
    const service = new MetricsService(sequelize, fakeConfigService(), logger);

    const text = await service.render();

    expect(text).toContain('promo_code_kafka_consumer_lag 0');
  });

  // TC-12: valid Prometheus text exposition format — HELP/TYPE per metric, parseable shape.
  it('renders a well-formed Prometheus text exposition body', async () => {
    const sequelize = fakeSequelize([{ pending_count: '1', oldest_pending_age_seconds: 5 }]);
    const service = new MetricsService(sequelize, fakeConfigService(), logger);
    service.incrementCodesGenerated('GRPC', 'SUCCESS');

    const text = await service.render();
    const lines = text.split('\n').filter(Boolean);

    for (const metricName of [
      'promo_code_codes_generated_total',
      'promo_code_generation_duration_seconds',
      'promo_code_outbox_pending_count',
      'promo_code_outbox_oldest_pending_age_seconds',
      'promo_code_kafka_consumer_lag',
    ]) {
      expect(lines.some((line) => line.startsWith(`# HELP ${metricName} `))).toBe(true);
      expect(lines.some((line) => line.startsWith(`# TYPE ${metricName} `))).toBe(true);
    }
    // Every non-comment line must be `name{labels} value` or `name value` — no stray output.
    for (const line of lines) {
      if (line.startsWith('#')) continue;
      expect(line).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?[0-9.]+$/);
    }
  });
});
