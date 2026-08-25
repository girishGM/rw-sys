/**
 * T-039 — the pure mapping functions `merchant-campaign-response.dto.ts` exports. Every branch a
 * unit test can reach without a database: date serialisation, `envelope()`, and — the one that
 * matters most — that the object literals these functions build carry exactly the fields
 * `MerchantCampaignListItemDto`/`MerchantCampaignDetailDto` declare and nothing else
 * (implementation note 2, TC-8/TC-9).
 */
import {
  envelope,
  toMerchantCampaignDetailDto,
  toMerchantCampaignListItemDto,
  toMerchantOwnActivityDto,
} from '@/modules/merchant-portal/dto/merchant-campaign-response.dto';
import {
  campaignMerchantRow,
  campaignRow,
  merchantActivityRow,
} from '../support/merchant-portal-doubles';

describe('envelope', () => {
  it('wraps the payload under `data`', () => {
    expect(envelope({ id: 1 })).toEqual({ data: { id: 1 } });
  });
});

describe('toMerchantCampaignListItemDto', () => {
  it('projects exactly the campaign header fields, dates as ISO strings', () => {
    const dto = toMerchantCampaignListItemDto(campaignRow());

    expect(dto).toEqual({
      id: 1,
      campaignCode: 'CMP-1',
      name: 'Summer Splash',
      description: null,
      region: 'EU',
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-02-01T00:00:00.000Z',
      status: 'active',
    });
    // Never the campaign's internal budget or its tenant id (implementation note 2).
    expect(dto).not.toHaveProperty('budgetAmount');
    expect(dto).not.toHaveProperty('budgetCurrency');
    expect(dto).not.toHaveProperty('tenantId');
    expect(dto).not.toHaveProperty('maxParticipants');
  });
});

describe('toMerchantOwnActivityDto', () => {
  it('projects the link plus the resolved activity name, commission rate kept as a string', () => {
    const dto = toMerchantOwnActivityDto(
      merchantActivityRow({ activityId: 50, storeId: 7, commissionRate: '4.25' }),
      'In-store purchase',
    );

    expect(dto).toEqual({
      activityId: 50,
      activityName: 'In-store purchase',
      storeId: 7,
      commissionRate: '4.25',
    });
    expect(typeof dto.commissionRate).toBe('string');
  });

  it('carries a null commission rate through as null, not coerced', () => {
    const dto = toMerchantOwnActivityDto(
      merchantActivityRow({ commissionRate: null }),
      'In-store purchase',
    );
    expect(dto.commissionRate).toBeNull();
  });
});

describe('toMerchantCampaignDetailDto', () => {
  it('combines the header, the participation row and the activities, and nothing else', () => {
    const dto = toMerchantCampaignDetailDto(campaignRow(), campaignMerchantRow(), [
      { activityId: 50, activityName: 'In-store purchase', storeId: null, commissionRate: '2.50' },
    ]);

    expect(dto).toEqual({
      id: 1,
      campaignCode: 'CMP-1',
      name: 'Summer Splash',
      description: null,
      region: 'EU',
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-02-01T00:00:00.000Z',
      status: 'active',
      maxParticipants: 5,
      participation: { status: 'active', joinedAt: '2026-01-05T00:00:00.000Z' },
      myActivities: [
        {
          activityId: 50,
          activityName: 'In-store purchase',
          storeId: null,
          commissionRate: '2.50',
        },
      ],
    });
    expect(dto).not.toHaveProperty('budgetAmount');
    expect(dto).not.toHaveProperty('budgetCurrency');
  });

  it('an empty activities list serialises to an empty array, not an omitted field', () => {
    const dto = toMerchantCampaignDetailDto(campaignRow(), campaignMerchantRow(), []);
    expect(dto.myActivities).toEqual([]);
  });
});
