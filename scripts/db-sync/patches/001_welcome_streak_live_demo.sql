-- Adds the "Welcome Streak Live Demo" campaign (built locally 2026-09-03, local
-- reward_config.tenant_campaigns id 530457 under local tenant_id=1 "Demo Tenant") onto Render's
-- reward-portal-db, under Render's own tenant_id=7 "Test App Demo" — the tenant that already
-- holds this same demo's other 3 campaigns (Weekend Promo Blitz / Summer Cashback Sprint /
-- Refer & Earn), confirming id=7 is Render's equivalent of local's tenant 1, just numbered
-- differently (trackers/campaigns/activities are `generated always as identity` and diverged
-- independently between the two environments — never assume a local id is valid on Render;
-- resolve by natural key, as this file does for merchant/activity/rule/promo-code-config below).
--
-- Every foreign id below was resolved against Render's OWN data, not copied from local:
--   tenant_id=7            reward_config.tenants        "Test App Demo" (local tenant 1's counterpart)
--   merchant_id=13         reward_config.merchants       "Test App Demo Merchant" (only merchant under tenant 7)
--   activity_id=3           reward_config.activities      "WEEKEND_TRANSACTION" under tenant 7
--   rule_id=14, rule_version_id=14   reward_config.rule_master / rule_versions
--                            "RULE_ACTIVITY_WINDOW_001" / v1 — already seeded on Render (T105_002),
--                            just at a different id than local's 3587/1175.
--   promo_code_config_id='c1dea156-d00f-42ae-be87-91affaeaaa2e'   promo_code.promo_code_config
--                            "10% Off Welcome Code" — already existed on Render before this patch.
--
-- Purely additive: does not modify or delete any pre-existing Render row. No in-file
-- idempotency guard — render-db-sync.js's own tracking table (reward_portal.demo_data_patches)
-- is what stops this from running twice; a manual re-run would fail loudly on the
-- (tenant_id, campaign_code) unique constraint, which is the correct behavior (surface the
-- mistake, don't silently no-op).
BEGIN;

INSERT INTO reward_config.tenant_campaigns
  (tenant_id, campaign_code, name, description, start_date, end_date, status, created_by, approved_by, approved_at)
VALUES
  (7, 'WELCOME_STREAK_LIVE', 'Welcome Streak Live Demo',
   'Live demo: promo-code-service reward, dynamic test-app sync.',
   '2026-09-03 08:00:00+08', '2026-12-31 08:00:00+08', 'active', 'demo-sync', 'demo-sync', now())
RETURNING id AS campaign_id \gset

INSERT INTO reward_config.trackers (tenant_id, tracker_code, name, completion_logic, status)
VALUES (7, 'TRK-530457-OQIDT5', 'Welcome Streak Tracker', 'all', 'active')
RETURNING id AS tracker_id \gset

INSERT INTO reward_config.tracker_components (tenant_id, component_code, name, activity_id, status)
VALUES (7, 'CMP-530457-JHISLD', 'Weekend transaction step', 3, 'active')
RETURNING id AS component_id \gset

INSERT INTO reward_config.tracker_tracker_components (tracker_id, component_id, sequence_order, is_mandatory)
VALUES (:tracker_id, :component_id, 1, true);

INSERT INTO reward_config.tracker_component_rules
  (tenant_id, tracker_component_id, rule_id, rule_version_id, config, status)
VALUES (7, :component_id, 14, 14, '{"windowType":"DAILY_HOURS","windowStart":"00:00","windowEnd":"23:59"}', 'active');

INSERT INTO reward_config.tenant_campaign_trackers (tenant_id, campaign_id, tracker_id, is_primary, status)
VALUES (7, :campaign_id, :tracker_id, false, 'active');

INSERT INTO reward_config.campaign_merchants (tenant_id, campaign_id, merchant_id, status)
VALUES (7, :campaign_id, 13, 'active');

INSERT INTO promo_code.campaign_promo_config
  (promo_code_config_id, tenant_id, bind_level, bind_ref_id, status, bound_by)
VALUES ('c1dea156-d00f-42ae-be87-91affaeaaa2e', '7', 'TRACKER', :'tracker_id', 'ACTIVE', 'demo-sync');

COMMIT;
