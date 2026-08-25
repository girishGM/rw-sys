import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListBlastsQueryDto } from '@/modules/blasts/dto/list-blasts-query.dto';

describe('ListBlastsQueryDto', () => {
  it('accepts an empty query', async () => {
    const errors = await validate(plainToInstance(ListBlastsQueryDto, {}));
    expect(errors).toHaveLength(0);
  });

  it('accepts page/pageSize/entityType/entityId', async () => {
    const errors = await validate(
      plainToInstance(ListBlastsQueryDto, {
        page: '2',
        pageSize: '10',
        entityType: 'rule',
        entityId: '5',
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('rejects an entityType outside rule/reward', async () => {
    const errors = await validate(plainToInstance(ListBlastsQueryDto, { entityType: 'campaign' }));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects page below 1', async () => {
    const errors = await validate(plainToInstance(ListBlastsQueryDto, { page: '0' }));
    expect(errors.length).toBeGreaterThan(0);
  });
});
