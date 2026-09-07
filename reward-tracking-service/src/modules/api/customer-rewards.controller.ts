/**
 * T-RTS-030. Every customer-facing endpoint from `brain-storm/04-API-DESIGN.md` §1. A thin transport
 * adapter (R8) — every response is built by mapping a query-service row through the one shared
 * `shapeRewardGroup` (R4), never a second, endpoint-local shaping decision.
 *
 * Guarded end-to-end by `CustomerAuthGuard` (T-RTS-032) — `request.customerAuth.tenantId` and
 * `.customerId` are the only source of truth for *whose* data this controller ever reads; the
 * `:customerId` path parameter exists for readability/REST convention only, the guard already
 * enforces it matches the verified token's own `customerId` before any handler here runs (403 on
 * mismatch, `customer-auth.guard.ts`'s own header). `customerIdHash` is computed once per request
 * from the verified plaintext, immediately before it's used in a query, and never logged (R6) — this
 * controller reuses `CustomerIdCryptoService.hash` (T-RTS-010's own primitive) rather than
 * reimplementing hashing a second time.
 *
 * `@UseInterceptors(ApiObservabilityInterceptor)` (T-RTS-050) is this controller's one, shared
 * `reward_tracking_api_requests_total`/structured-logging call site — see that file's own header
 * for why a single class-level interceptor, not nine per-handler manual increments.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  CustomerAuthGuard,
  type RequestWithCustomerAuth,
} from '@/modules/auth/customer-auth.guard';
import { CustomerIdCryptoService } from '@/modules/ingestion/customer-id-crypto.service';
import { ApiObservabilityInterceptor } from './api-observability.interceptor';
import {
  CustomerRewardLedgerQueryService,
  type CustomerRewardGroupTotalsRow,
} from './customer-reward-ledger-query.service';
import { CustomerRewardBalanceRepository } from './customer-reward-balance.repository';
import { shapeRewardGroup, type ShapedRewardGroup } from './reward-kind-response-shaper';

function toGroupTotalsShape(row: CustomerRewardGroupTotalsRow): ShapedRewardGroup {
  return shapeRewardGroup({
    rewardCategory: row.reward_category,
    rewardKind: row.reward_kind,
    unitType: row.unit_type,
    unitCode: row.unit_code,
    totalValue: row.total_value,
    totalCount: Number(row.total_count),
  });
}

/** Display-only trimming of a stored `decimal(18,4)` string for natural-language message text (e.g.
 * `"100.0000"` -> `"100"`, `"5.2500"` -> `"5.25"`) — never applied to a JSON field value itself
 * (those keep the raw stored precision, matching doc 04 §1.1's own `"5.0000"`/`"8.0000"` examples).
 * `Number(...)` is safe here purely for display rounding at this scale (`decimal(18,4)`); this value
 * is never fed back into a calculation. */
function formatForMessage(rawDecimal: string): string {
  const parsed = Number(rawDecimal);
  return Number.isFinite(parsed) ? parsed.toString() : rawDecimal;
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Doc 03 §6 / doc 04 §1.4 — the message template branches on `rewardKind`, never phrasing a rate as
 * a fabricated currency/points amount and never phrasing a real amount as a rate (implementation
 * note 3). `reward_kind: null` (today's actual pipeline-wide state until `T-173`/`T-RAP-062`/
 * `T-RR-062` land) gets the same conservative, value-free phrasing as `PHYSICAL` — never a guess at
 * what `issuedValue` might mean.
 */
export function buildExpiringMessage(row: {
  reward_kind: string | null;
  issued_value: string;
  expires_at: Date;
  reward_code: string | null;
}): string {
  const dateStr = formatDateOnly(row.expires_at);
  const value = formatForMessage(row.issued_value);

  switch (row.reward_kind) {
    case 'POINTS':
      return `${value} points expire on ${dateStr} — use them soon.`;
    case 'PERCENTAGE':
      return `Your ${value}%-off voucher expires on ${dateStr} — use it soon.`;
    case 'FIXED_AMOUNT':
      return `Your ${value} reward expires on ${dateStr} — use it soon.`;
    case 'PROMO_CODE':
      return row.reward_code
        ? `Your promo code ${row.reward_code} expires on ${dateStr} — use it soon.`
        : `Your promo code expires on ${dateStr} — use it soon.`;
    case 'PHYSICAL':
    default:
      // Also covers `null` (not yet populated upstream) — conservative, value-free phrasing.
      return `Your reward expires on ${dateStr} — use it soon.`;
  }
}

@Controller('customers/:customerId/rewards')
@UseGuards(CustomerAuthGuard)
@UseInterceptors(ApiObservabilityInterceptor)
export class CustomerRewardsController {
  constructor(
    private readonly ledgerQuery: CustomerRewardLedgerQueryService,
    private readonly balanceRepository: CustomerRewardBalanceRepository,
    private readonly crypto: CustomerIdCryptoService,
  ) {}

  /** Doc 04 §1.1. */
  @Get('summary')
  async getSummary(
    @Req() request: RequestWithCustomerAuth,
    @Param('customerId') customerId: string,
    @Query('campaignCode') campaignCode?: string,
  ): Promise<{ customerId: string; campaignCode?: string; components: unknown[] }> {
    const { tenantId, customerId: verifiedCustomerId } = request.customerAuth;
    const customerIdHash = this.crypto.hash(verifiedCustomerId);

    const rows = await this.ledgerQuery.findLedgerComponents({
      tenantId,
      customerIdHash,
      campaignCode,
    });

    return {
      customerId,
      ...(campaignCode !== undefined ? { campaignCode } : {}),
      components: rows.map((row) => ({
        trackerCode: row.tracker_code,
        componentCode: row.tracker_component_code,
        ...shapeRewardGroup({
          rewardCategory: row.reward_category,
          rewardKind: row.reward_kind,
          unitType: row.unit_type,
          unitCode: row.unit_code,
          totalValue: row.total_reward_value,
          totalCount: row.total_reward_count,
        }),
      })),
    };
  }

  /** Doc 04 §1.2. */
  @Get('tracker/:trackerCode')
  async getTrackerTotals(
    @Req() request: RequestWithCustomerAuth,
    @Param('customerId') customerId: string,
    @Param('trackerCode') trackerCode: string,
  ): Promise<{ customerId: string; trackerCode: string; totals: ShapedRewardGroup[] }> {
    const { tenantId, customerId: verifiedCustomerId } = request.customerAuth;
    const customerIdHash = this.crypto.hash(verifiedCustomerId);

    const rows = await this.ledgerQuery.findTrackerTotals({
      tenantId,
      customerIdHash,
      trackerCode,
    });

    return { customerId, trackerCode, totals: rows.map(toGroupTotalsShape) };
  }

  /** Doc 04 §1.3. */
  @Get('campaign/:campaignCode')
  async getCampaignTotals(
    @Req() request: RequestWithCustomerAuth,
    @Param('customerId') customerId: string,
    @Param('campaignCode') campaignCode: string,
  ): Promise<{ customerId: string; campaignCode: string; totals: ShapedRewardGroup[] }> {
    const { tenantId, customerId: verifiedCustomerId } = request.customerAuth;
    const customerIdHash = this.crypto.hash(verifiedCustomerId);

    const rows = await this.ledgerQuery.findCampaignTotals({
      tenantId,
      customerIdHash,
      campaignCode,
    });

    return { customerId, campaignCode, totals: rows.map(toGroupTotalsShape) };
  }

  /** Doc 04 §1.4. `withinDays` is required and must be a positive integer — no implicit default, so
   * a caller can never silently receive a different window than the one it thinks it asked for. */
  @Get('expiring')
  async getExpiring(
    @Req() request: RequestWithCustomerAuth,
    @Query('withinDays') withinDaysRaw?: string,
  ): Promise<{ expiring: unknown[] }> {
    const withinDays = this.parseWithinDays(withinDaysRaw);
    const { tenantId, customerId: verifiedCustomerId } = request.customerAuth;
    const customerIdHash = this.crypto.hash(verifiedCustomerId);

    // The population step (customer-reward-balance.repository.ts's own header) — eager, scoped to
    // this one customer, so this read always reflects every reward ingested for them so far.
    await this.balanceRepository.populateMissing({ tenantId, customerIdHash });

    const rows = await this.balanceRepository.findExpiring({
      tenantId,
      customerIdHash,
      withinDays,
    });

    return {
      expiring: rows.map((row) => ({
        rewardCategory: row.reward_category,
        rewardKind: row.reward_kind,
        issuedValue: row.issued_value,
        expiresAt: row.expires_at,
        campaignCode: row.campaign_code,
        ...(row.external_reference_id !== null
          ? { externalReferenceId: row.external_reference_id }
          : {}),
        ...(row.reward_kind === 'PROMO_CODE' && row.promo_code_config_id !== null
          ? {
              promoCodeConfigId: row.promo_code_config_id,
              ...(row.promo_code_config_version_no !== null
                ? { promoCodeConfigVersionNo: row.promo_code_config_version_no }
                : {}),
            }
          : {}),
        message: buildExpiringMessage(row),
      })),
    };
  }

  private parseWithinDays(raw: string | undefined): number {
    if (raw === undefined || raw.trim().length === 0) {
      throw new BadRequestException('withinDays query parameter is required');
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new BadRequestException('withinDays must be a positive integer');
    }
    return parsed;
  }
}
