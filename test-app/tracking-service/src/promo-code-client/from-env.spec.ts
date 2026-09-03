import { createPromoCodeClientFromEnv } from './from-env';
import { PromoCodeClient } from './client';

describe('createPromoCodeClientFromEnv', () => {
  it('builds a PromoCodeClient when both vars are present', () => {
    const client = createPromoCodeClientFromEnv({
      PROMO_CODE_SERVICE_BASE_URL: 'http://localhost:3010',
      PROMO_CODE_SERVICE_GENERATION_TOKEN: 'secret',
    } as NodeJS.ProcessEnv);

    expect(client).toBeInstanceOf(PromoCodeClient);
  });

  it('returns null (not a throw) when unconfigured — an optional integration', () => {
    expect(createPromoCodeClientFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('returns null when only one of the two vars is present', () => {
    expect(
      createPromoCodeClientFromEnv({
        PROMO_CODE_SERVICE_BASE_URL: 'http://localhost:3010',
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});
