import { DbPoolSampler } from './db-pool.sampler';

function sequelizeWithPool(pool: unknown): unknown {
  return { connectionManager: { pool } };
}

describe('DbPoolSampler', () => {
  it('computes utilisation as using / maxSize, clamped to [0, 1]', () => {
    const sampler = new DbPoolSampler(
      sequelizeWithPool({ using: 4, available: 16, waiting: 0, maxSize: 20 }) as never,
    );

    const snapshot = sampler.sample();
    expect(snapshot).toEqual({
      using: 4,
      available: 16,
      waiting: 0,
      maxSize: 20,
      utilisation: 0.2,
    });
  });

  it('clamps utilisation to 1 when using somehow exceeds maxSize', () => {
    const sampler = new DbPoolSampler(
      sequelizeWithPool({ using: 25, available: 0, waiting: 3, maxSize: 20 }) as never,
    );

    expect(sampler.sample()?.utilisation).toBe(1);
  });

  it('returns null rather than throwing when the pool is missing entirely', () => {
    const sampler = new DbPoolSampler({ connectionManager: {} } as never);
    expect(sampler.sample()).toBeNull();
  });

  it('returns null rather than throwing when a field is the wrong type', () => {
    const sampler = new DbPoolSampler(
      sequelizeWithPool({ using: 'four', available: 16, waiting: 0, maxSize: 20 }) as never,
    );
    expect(sampler.sample()).toBeNull();
  });

  it('utilisation is null (not NaN, not thrown) when maxSize is 0', () => {
    const sampler = new DbPoolSampler(
      sequelizeWithPool({ using: 0, available: 0, waiting: 0, maxSize: 0 }) as never,
    );
    expect(sampler.sample()?.utilisation).toBeNull();
  });
});
