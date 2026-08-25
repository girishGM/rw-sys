/**
 * T-039 — the merchant feature's public surface. `router.tsx` imports `MerchantCampaignsPage`
 * from here, the same shape `features/trace/index.ts` (T-045) and `features/merchants/index.ts`
 * (T-036) establish for their own routes.
 */
export { MerchantCampaignsPage } from './MerchantCampaignsPage';
export {
  fetchMerchantCampaign,
  fetchMerchantCampaigns,
  fetchMerchantSummary,
  merchantCampaignQueryKey,
  merchantCampaignsQueryKey,
  merchantSummaryQueryKey,
  useMerchantCampaignQuery,
  useMerchantCampaignsQuery,
  useMerchantSummaryQuery,
} from './api';
