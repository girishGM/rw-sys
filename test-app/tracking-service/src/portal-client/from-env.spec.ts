import { createPortalClientFromEnv } from './from-env';
import { PortalClient } from './client';

describe('createPortalClientFromEnv', () => {
  it('builds a PortalClient when all required vars are present', () => {
    const client = createPortalClientFromEnv({
      PORTAL_BASE_URL: 'http://localhost:3001',
      PORTAL_LOGIN_EMAIL: 'demo@example.invalid',
      PORTAL_LOGIN_PASSWORD: 'secret',
    } as NodeJS.ProcessEnv);

    expect(client).toBeInstanceOf(PortalClient);
  });

  it('throws naming every missing required var', () => {
    expect(() => createPortalClientFromEnv({} as NodeJS.ProcessEnv)).toThrow(
      /PORTAL_BASE_URL.*PORTAL_LOGIN_EMAIL.*PORTAL_LOGIN_PASSWORD/,
    );
  });

  it('rejects a non-numeric PORTAL_CACHE_TTL_MS', () => {
    expect(() =>
      createPortalClientFromEnv({
        PORTAL_BASE_URL: 'http://localhost:3001',
        PORTAL_LOGIN_EMAIL: 'demo@example.invalid',
        PORTAL_LOGIN_PASSWORD: 'secret',
        PORTAL_CACHE_TTL_MS: 'not-a-number',
      } as NodeJS.ProcessEnv),
    ).toThrow(/PORTAL_CACHE_TTL_MS/);
  });
});
