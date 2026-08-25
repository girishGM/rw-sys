import { SHARED_PACKAGE_NAME } from './index';

describe('packages/shared scaffold', () => {
  it('builds and is importable', () => {
    expect(SHARED_PACKAGE_NAME).toBe('@reward-portal/shared');
  });
});
