/**
 * T-045 — `NullConfigFetchAdapter`: the T-047 seam. One behaviour to prove: it never answers with
 * anything but `null`, so `trace.service.ts` always reports `configFetches: 'not_configured'`
 * until a real adapter is wired.
 */
import { NullConfigFetchAdapter } from '@/modules/trace/adapters/config-fetch.adapter';

describe('NullConfigFetchAdapter', () => {
  it('always answers null, regardless of correlation id or limit', async () => {
    const adapter = new NullConfigFetchAdapter();
    await expect(adapter.fetchEntries('01J8F3K9QP2M7N', 100)).resolves.toBeNull();
    await expect(adapter.fetchEntries('', 0)).resolves.toBeNull();
  });
});
