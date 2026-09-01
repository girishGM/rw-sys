/**
 * T-004 — the subset of {@link PortalClient}'s public API the engine/routes layer actually needs,
 * declared as a structural interface rather than importing the concrete class. This is what lets
 * route/engine tests inject a lightweight fake instead of a real, network-backed `PortalClient`
 * (which requires a live `portal/back-end` to even construct meaningfully) — a real `PortalClient`
 * instance satisfies this interface as-is (TypeScript structural typing), so `server.ts` passes
 * one through unchanged. This is not a competing implementation of anything `portal-client` owns.
 */
import type { PortalCampaign, PortalCampaignJourney } from '../portal-client/types';

export interface PortalDataSource {
  getCampaigns(): Promise<readonly PortalCampaign[]>;
  getCampaignJourney(campaignId: number): Promise<PortalCampaignJourney>;
}
