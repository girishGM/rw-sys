import 'dotenv/config';
import { createApp } from './app';
import { ActivityHistoryStore } from './data/activities';
import { CUSTOMERS } from './data/customers';
import { seedDemoData } from './data/seed';
import { createPortalClientFromEnv } from './portal-client';
import { createPromoCodeClientFromEnv } from './promo-code-client';
import { SseHub, type AppState } from './routes';

const PORT = Number(process.env.PORT ?? 4001);

async function main(): Promise<void> {
  const portalClient = createPortalClientFromEnv();
  const { progress, rewards } = await seedDemoData(portalClient);

  const promoCodeClient = createPromoCodeClientFromEnv();
  console.info(
    promoCodeClient
      ? 'promo-code-service generation: configured — promo_code rewards will call the real service'
      : 'promo-code-service generation: not configured (PROMO_CODE_SERVICE_BASE_URL/' +
          'PROMO_CODE_SERVICE_GENERATION_TOKEN unset) — promo_code rewards use an invented fallback code',
  );

  const state: AppState = {
    customers: CUSTOMERS,
    progress,
    rewards,
    // T-013 — starts empty; there is no "seeded" activity history, only whatever real
    // `POST /api/activities` calls accumulate for the life of this process.
    activities: new ActivityHistoryStore(),
    portal: portalClient,
    promoCode: promoCodeClient,
    sse: new SseHub(),
  };

  const app = createApp(state);

  app.listen(PORT, () => {
    console.info(`tracking-service listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('tracking-service failed to start:', err);
  process.exitCode = 1;
});
