/**
 * T-170 — the bind request against a **real, locally running promo-code-service**.
 *
 * Every other test of this path stops at a stub: `bindings.service.spec.ts` proves what
 * `BindingsService` hands to the client, and `t127-promo-code-attach.e2e-spec.ts` proves what a
 * real socket carries out of the portal's own endpoint. Neither can prove the one thing this task
 * exists to fix — that **promo-code-service accepts it**. That question is decided by a validator
 * in another repository, and a portal-side stub will agree with whatever the portal sends by
 * construction (AGENT-PROTOCOL §3: *"if the specified value were wrong, would this test still
 * pass?"* — for a stub, always yes).
 *
 * So this file is opt-in and talks to the real service:
 *
 * ```bash
 * # promo-code-service, migrated and seeded, in another shell:
 * cd promo-code-service && npm run start        # or: node dist/main.js
 *
 * cd portal/back-end
 * RUN_PROMO_CODE_LIVE=1 \
 *   PROMO_CODE_LIVE_URL=http://localhost:3010 \
 *   PROMO_CODE_LIVE_TOKEN=<promo-code-service's INTERNAL_SERVICE_TOKEN> \
 *   PROMO_CODE_LIVE_CONFIG_ID=<an ACTIVE promo_code_config whose tenant_id is PROMO_CODE_LIVE_TENANT_ID> \
 *   PROMO_CODE_LIVE_TENANT_ID=1 PROMO_CODE_LIVE_CAMPAIGN_ID=529444 PROMO_CODE_LIVE_USER_ID=182602 \
 *   npm run test:e2e -- t170-promo-code-bind-live
 * ```
 *
 * Without `RUN_PROMO_CODE_LIVE=1` the suite skips itself, exactly like `RUN_UI_VERIFICATION`
 * elsewhere in this directory — CI has no promo-code-service to talk to, and a suite that fails
 * because a dependency is not running teaches nobody anything.
 *
 * The ids default to real rows in the local dev database (`tenant_id = 1` "Demo Tenant", campaign
 * `529444`, maker `182602`) so that the row promo-code-service writes is inspectable afterwards
 * and reads as the portal's own ids, with nothing to decode:
 *
 * ```sql
 * SELECT tenant_id, bind_level, bind_ref_id, bound_by FROM promo_code.campaign_promo_config;
 * ```
 */
import { ConfigService } from '@nestjs/config';
import type { Env } from '@/config/env.schema';
import {
  PromoCodeServiceClient,
  type PromoCodeBindRequest,
} from '@/modules/promo-code-integration/promo-code-service.client';
import { PromoCodeServiceBindError } from '@/modules/promo-code-integration/promo-code-service.errors';

jest.setTimeout(60_000);

const LIVE = process.env.RUN_PROMO_CODE_LIVE === '1';

const BASE_URL = process.env.PROMO_CODE_LIVE_URL ?? 'http://localhost:3010';
const TOKEN = process.env.PROMO_CODE_LIVE_TOKEN ?? '';
const CONFIG_ID = process.env.PROMO_CODE_LIVE_CONFIG_ID ?? '';

/** The portal's own ids — integers in `reward_config`, and integers is the whole point. */
const TENANT_ID = Number(process.env.PROMO_CODE_LIVE_TENANT_ID ?? '1');
const CAMPAIGN_ID = Number(process.env.PROMO_CODE_LIVE_CAMPAIGN_ID ?? '529444');
const USER_ID = Number(process.env.PROMO_CODE_LIVE_USER_ID ?? '182602');

/** The production client, pointed at the live service. No stub anywhere in this file. */
function liveClient(): PromoCodeServiceClient {
  const config = {
    get: (key: keyof Env): unknown =>
      key === 'PROMO_CODE_SERVICE_BASE_URL' ? BASE_URL : (TOKEN as unknown),
  };
  return new PromoCodeServiceClient(config as unknown as ConfigService<Env, true>);
}

/**
 * Exactly the body `BindingsService.registerPromoCodeBinding` builds for a campaign-level attach —
 * the shape `t127-promo-code-attach.e2e-spec.ts` asserts coming out of the portal's own endpoint,
 * with that suite's dynamic fixture ids replaced by the local database's real ones.
 */
function request(): PromoCodeBindRequest {
  return {
    promoCodeConfigId: CONFIG_ID,
    tenantId: String(TENANT_ID),
    bindLevel: 'CAMPAIGN',
    bindRefId: String(CAMPAIGN_ID),
    boundBy: String(USER_ID),
  };
}

const describeLive = LIVE ? describe : describe.skip;

describeLive('T-170 · the bind contract, against a real promo-code-service', () => {
  beforeAll(() => {
    if (TOKEN === '' || CONFIG_ID === '') {
      throw new Error(
        'RUN_PROMO_CODE_LIVE=1 needs PROMO_CODE_LIVE_TOKEN and PROMO_CODE_LIVE_CONFIG_ID — see this file’s header',
      );
    }
  });

  it('TC-4: the portal’s real ids, sent as plain strings, are accepted', async () => {
    // Resolving is not a formality: the client's documented invariant is that it returns only when
    // promo-code-service answered 2xx, and it turns every 4xx — including the `400` this task
    // exists to stop — into a throw. So `resolves` here *is* "a campaign_promo_config row now
    // exists carrying tenant 1, campaign 529444, user 182602, verbatim".
    await expect(liveClient().bind(request())).resolves.toBeUndefined();
  });

  it('TC-5: the pre-fix body — the same ids as JSON numbers — is rejected with a 400', async () => {
    // The regression proof. T-166 sent `number` for these three fields; promo-code-service's DTO
    // validator refuses that outright (`Expected string, received number`), which the client
    // normalises to its own 502. If this case ever starts passing, the fix has been reverted or
    // the far side has quietly widened its validator again — either way TC-4 above would have
    // stopped proving anything.
    const preFix = {
      promoCodeConfigId: CONFIG_ID,
      tenantId: TENANT_ID,
      bindLevel: 'CAMPAIGN',
      bindRefId: CAMPAIGN_ID,
      boundBy: USER_ID,
    } as unknown as PromoCodeBindRequest;

    const error: unknown = await liveClient()
      .bind(preFix)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PromoCodeServiceBindError);
    // Not a 409 (a config the maker could change) and not a timeout — a contract rejection.
    expect((error as PromoCodeServiceBindError).status).toBe(502);
  });

  it('TC-5b: a UUID-shaped tenantId — the rejected client-side encoding — is refused as a 409', async () => {
    // Why the "encode the portal's integers into valid UUIDs and leave promo-code-service alone"
    // alternative was rejected, demonstrated rather than argued: it clears format validation and
    // then fails the equality check against `promo_code_config.tenant_id` forever. A permanent
    // 409 dressed as a business rejection is strictly harder to diagnose than the 400 above.
    const encoded = {
      ...request(),
      tenantId: `00000000-0000-4000-8000-${String(TENANT_ID).padStart(12, '0')}`,
    };

    const error: unknown = await liveClient()
      .bind(encoded)
      .catch((caught: unknown) => caught);

    expect(error).not.toBeUndefined();
    expect((error as { status?: number }).status).toBe(409);
  });
});
