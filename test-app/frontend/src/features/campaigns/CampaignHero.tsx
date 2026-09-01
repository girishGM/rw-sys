/**
 * T-008 — Campaign Detail's hero banner (`UI-UX-DESIGN.md` "Core components": full-width, ~172px
 * tall, 24px radius, the *same* campaign 2-stop gradient as its chip everywhere else, a large
 * low-opacity decorative icon watermark top-right, status pill + campaign name overlaid
 * bottom-left in white text). Uses this feature's own `getCampaignTheme` — the same source
 * (`ARCHITECTURE.md` §5) `RunningCampaignsList`/`TrackerRow` (T-007) read, so the gradient can
 * never drift into a different-looking variant (this task's implementation notes + TC-2).
 */
import { Badge } from '../../components/Badge';
import { campaignStatusTone } from './campaignStatus';
import { getCampaignTheme } from './campaignTheme';

export interface CampaignHeroProps {
  campaignCode: string;
  name: string;
  status: string;
}

export function CampaignHero({ campaignCode, name, status }: CampaignHeroProps) {
  const { Icon, gradientClassName } = getCampaignTheme(campaignCode);

  return (
    <div
      className={`relative flex min-h-[172px] flex-col justify-end overflow-hidden rounded-[24px] bg-gradient-to-br p-6 text-white sm:p-8 ${gradientClassName}`}
    >
      <Icon
        aria-hidden="true"
        className="pointer-events-none absolute -right-6 -top-6 h-[230px] w-[230px] opacity-[0.16]"
      />
      <div className="relative z-10 flex flex-col items-start gap-2.5">
        <Badge
          tone={campaignStatusTone(status)}
          className="!bg-white/20 !text-white capitalize backdrop-blur-sm"
        >
          {status}
        </Badge>
        <h1 className="font-heading text-2xl font-bold sm:text-[28px]">{name}</h1>
      </div>
    </div>
  );
}
