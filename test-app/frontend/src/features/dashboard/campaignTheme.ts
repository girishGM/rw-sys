/**
 * T-007 — per-campaign brand color + icon (`ARCHITECTURE.md` §5), used consistently everywhere a
 * campaign appears: this page's running-campaigns chip and trackers-widget icon now, T-008's
 * Campaign Detail hero banner and any future campaign chip later. Values are copied verbatim from
 * ARCHITECTURE.md §5's own per-campaign table rather than derived — that section is explicit that
 * "the same campaign reads as the same color everywhere", so a later feature (T-008) reproduces
 * these exact gradient stops from the same source doc rather than importing this module, since
 * `features/dashboard/**` and `features/campaigns/**` are two different tasks' owned file scopes
 * (`AGENT-PROTOCOL.md` R3) and neither owns a shared cross-feature module to put this in.
 */
import type { ComponentType } from 'react';
import {
  ShoppingBagIcon,
  UserPlusIcon,
  CalendarCheckIcon,
  GiftIcon,
  type IconProps,
} from '../../components/icons';

export interface CampaignTheme {
  readonly Icon: ComponentType<IconProps>;
  /** Tailwind arbitrary-value gradient stops (`bg-gradient-to-br` companion) — the exact 2-stop
   * `oklch()` gradient ARCHITECTURE.md §5 assigns this campaign. */
  readonly gradientClassName: string;
}

const CAMPAIGN_THEMES: Readonly<Record<string, CampaignTheme>> = {
  SUMMER_CASHBACK_SPRINT: {
    Icon: ShoppingBagIcon,
    gradientClassName: 'from-[oklch(74%_0.14_55)] to-[oklch(65%_0.18_30)]',
  },
  REFER_AND_EARN: {
    Icon: UserPlusIcon,
    gradientClassName: 'from-[oklch(64%_0.15_290)] to-[oklch(58%_0.17_255)]',
  },
  WEEKEND_PROMO_BLITZ: {
    Icon: CalendarCheckIcon,
    gradientClassName: 'from-[oklch(68%_0.14_165)] to-[oklch(62%_0.13_195)]',
  },
};

/** Falls back to a generic gift icon + the theme's own accent/secondary tokens for any campaign
 * code outside ARCHITECTURE.md §5's fixed 3-campaign table — keeps this widget from crashing (or
 * silently rendering nothing) if the demo roster ever grows past those 3. */
const DEFAULT_THEME: CampaignTheme = {
  Icon: GiftIcon,
  gradientClassName: 'from-accent to-secondary',
};

export function getCampaignTheme(campaignCode: string): CampaignTheme {
  return CAMPAIGN_THEMES[campaignCode] ?? DEFAULT_THEME;
}
