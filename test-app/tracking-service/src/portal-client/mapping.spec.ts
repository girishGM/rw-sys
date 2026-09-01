import { toPortalCampaign, toPortalCampaignJourney } from './mapping';

describe('toPortalCampaign', () => {
  it('maps exactly the fields this app uses, nothing invented', () => {
    const mapped = toPortalCampaign({
      id: 1,
      campaignCode: 'WEEKEND_PROMO_BLITZ',
      name: 'Weekend Promo Blitz',
      description: null,
      startDate: '2026-08-15',
      endDate: '2026-09-15',
      status: 'active',
    });

    expect(mapped).toEqual({
      id: 1,
      campaignCode: 'WEEKEND_PROMO_BLITZ',
      name: 'Weekend Promo Blitz',
      description: null,
      startDate: '2026-08-15',
      endDate: '2026-09-15',
      status: 'active',
    });
  });
});

describe('toPortalCampaignJourney', () => {
  it('maps trackers and components, preserving real ids', () => {
    const journey = toPortalCampaignJourney({
      campaignId: 42,
      trackers: [
        {
          id: 7,
          trackerCode: 'TRK',
          name: 'Tracker',
          description: null,
          completionLogic: 'all',
          completionThreshold: null,
          isPrimary: true,
          status: 'active',
          components: [
            {
              id: 101,
              componentCode: 'COMP_1',
              name: 'Component 1',
              description: null,
              activityId: 5,
              activityName: 'Activity',
              sequenceOrder: 1,
              isMandatory: true,
              status: 'active',
            },
          ],
          rewards: [],
        },
      ],
      campaignRewards: [],
    });

    expect(journey.campaignId).toBe(42);
    expect(journey.trackers[0].id).toBe(7);
    expect(journey.trackers[0].components[0].id).toBe(101);
  });

  it('throws rather than silently coercing an unrecognised completionLogic', () => {
    expect(() =>
      toPortalCampaignJourney({
        campaignId: 1,
        trackers: [
          {
            id: 1,
            trackerCode: 'TRK',
            name: 'Tracker',
            description: null,
            completionLogic: 'bogus',
            completionThreshold: null,
            isPrimary: false,
            status: 'active',
            components: [],
            rewards: [],
          },
        ],
        campaignRewards: [],
      }),
    ).toThrow(/unrecognised tracker completionLogic/);
  });
});
