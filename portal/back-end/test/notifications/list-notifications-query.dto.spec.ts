/**
 * T-040 — `ListNotificationsQueryDto` validation. The controller-level whitelist behaviour
 * (TC-16's sibling for notifications, an unknown query key → 400) is proved in
 * `notifications.e2e-spec.ts` through the real global `ValidationPipe`; this suite proves the
 * DTO's own field-level rules fast.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListNotificationsQueryDto } from '@/modules/notifications/dto/list-notifications-query.dto';

async function errorsFor(input: Record<string, unknown>) {
  const dto = plainToInstance(ListNotificationsQueryDto, input);
  return validate(dto);
}

describe('ListNotificationsQueryDto', () => {
  it('accepts no params at all', async () => {
    expect(await errorsFor({})).toHaveLength(0);
  });

  it('accepts a valid page/pageSize', async () => {
    expect(await errorsFor({ page: '2', pageSize: '10' })).toHaveLength(0);
  });

  it('rejects page/pageSize below 1', async () => {
    expect(await errorsFor({ page: '0' })).not.toHaveLength(0);
    expect(await errorsFor({ pageSize: '-1' })).not.toHaveLength(0);
  });

  it('rejects a non-integer page', async () => {
    expect(await errorsFor({ page: 'abc' })).not.toHaveLength(0);
  });
});
