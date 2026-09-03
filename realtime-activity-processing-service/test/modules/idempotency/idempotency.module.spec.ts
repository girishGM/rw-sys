import { Test } from '@nestjs/testing';
import { IdempotencyModule } from '@/modules/idempotency/idempotency.module';
import { IdempotencyService } from '@/modules/idempotency/idempotency.service';
import { CorrelationIdService } from '@/modules/idempotency/correlation-id.service';

describe('IdempotencyModule', () => {
  it('provides and exports IdempotencyService and CorrelationIdService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [IdempotencyModule],
    }).compile();

    expect(moduleRef.get(IdempotencyService)).toBeInstanceOf(IdempotencyService);
    expect(moduleRef.get(CorrelationIdService)).toBeInstanceOf(CorrelationIdService);
  });
});
