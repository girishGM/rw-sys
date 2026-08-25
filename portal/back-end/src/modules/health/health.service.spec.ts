import { HealthService } from './health.service';

describe('HealthService', () => {
  it('returns true when sequelize.authenticate() resolves', async () => {
    const sequelize = { authenticate: jest.fn().mockResolvedValue(undefined) };
    const service = new HealthService(sequelize as never);

    await expect(service.isDatabaseReachable()).resolves.toBe(true);
    expect(sequelize.authenticate).toHaveBeenCalledTimes(1);
  });

  it('returns false, and never throws, when sequelize.authenticate() rejects', async () => {
    const sequelize = {
      authenticate: jest.fn().mockRejectedValue(new Error('connection refused')),
    };
    const service = new HealthService(sequelize as never);

    await expect(service.isDatabaseReachable()).resolves.toBe(false);
  });

  it('never leaks the driver error into its return value (03-API-CONTRACT.md §14)', async () => {
    const sequelize = {
      authenticate: jest
        .fn()
        .mockRejectedValue(new Error('password authentication failed for user "reward_app"')),
    };
    const service = new HealthService(sequelize as never);

    const result = await service.isDatabaseReachable();
    expect(result).toBe(false);
    // The return type is a bare boolean — there is no field this assertion could even miss,
    // which is the property TC-4 needs, not merely that this one message doesn't appear.
    expect(typeof result).toBe('boolean');
  });

  it('tolerates a non-Error rejection (defensive: some drivers reject with a string)', async () => {
    const sequelize = { authenticate: jest.fn().mockRejectedValue('ECONNREFUSED') };
    const service = new HealthService(sequelize as never);

    await expect(service.isDatabaseReachable()).resolves.toBe(false);
  });
});
