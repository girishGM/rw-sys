/**
 * T-007 — `getCampaignTheme` returns ARCHITECTURE.md §5's exact per-campaign icon + gradient for
 * each of the 3 real demo campaign codes, and a safe fallback for anything else.
 */
import { describe, expect, it } from 'vitest';
import { ShoppingBagIcon, UserPlusIcon, CalendarCheckIcon, GiftIcon } from '../../components/icons';
import { getCampaignTheme } from './campaignTheme';

describe('getCampaignTheme', () => {
  it('maps Summer Cashback Sprint to the shopping-bag icon and its amber/coral gradient', () => {
    const theme = getCampaignTheme('SUMMER_CASHBACK_SPRINT');
    expect(theme.Icon).toBe(ShoppingBagIcon);
    expect(theme.gradientClassName).toContain('oklch(74%_0.14_55)');
    expect(theme.gradientClassName).toContain('oklch(65%_0.18_30)');
  });

  it('maps Refer & Earn to the user-plus icon and its violet/blue gradient', () => {
    const theme = getCampaignTheme('REFER_AND_EARN');
    expect(theme.Icon).toBe(UserPlusIcon);
    expect(theme.gradientClassName).toContain('oklch(64%_0.15_290)');
    expect(theme.gradientClassName).toContain('oklch(58%_0.17_255)');
  });

  it('maps Weekend Promo Blitz to the calendar-check icon and its emerald/teal gradient', () => {
    const theme = getCampaignTheme('WEEKEND_PROMO_BLITZ');
    expect(theme.Icon).toBe(CalendarCheckIcon);
    expect(theme.gradientClassName).toContain('oklch(68%_0.14_165)');
    expect(theme.gradientClassName).toContain('oklch(62%_0.13_195)');
  });

  it('falls back to a generic gift icon + token gradient for an unknown campaign code', () => {
    const theme = getCampaignTheme('SOME_FUTURE_CAMPAIGN');
    expect(theme.Icon).toBe(GiftIcon);
    expect(theme.gradientClassName).toBe('from-accent to-secondary');
  });
});
