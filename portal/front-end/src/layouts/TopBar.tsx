/**
 * T-023 — the top bar (04-FRONTEND.md §1): mobile nav trigger, brand, context chip,
 * notification bell, user menu — in that order, left to right.
 *
 * T-129 — the theme switcher joins the same right-hand cluster, ahead of the notification bell:
 * a portal-wide preference reads more naturally next to the account-level controls than buried
 * in the nav. Requires a `<ThemeProvider>` ancestor (`app/routeStubs.tsx`'s `ProtectedLayout`
 * already supplies one, the same way it supplies `useBootstrap()`'s `<BootstrapProvider>`).
 */
import { Menu } from 'lucide-react';
import { cx } from '../components/internal/cx';
import { ThemeSwitcher } from '../components/ThemeSwitcher';
import { ContextChip } from './ContextChip';
import { NotificationBell } from './NotificationBell';
import { UserMenu } from './UserMenu';

export interface TopBarProps {
  onOpenMobileNav: () => void;
}

export function TopBar({ onOpenMobileNav }: TopBarProps) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 lg:px-6">
      <button
        type="button"
        onClick={onOpenMobileNav}
        aria-label="Open menu"
        className={cx(
          'rounded-control p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700 lg:hidden',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500',
        )}
      >
        <Menu className="size-5" aria-hidden="true" />
      </button>

      <span className="text-sm font-semibold text-slate-900">Reward Portal</span>

      <div className="ml-auto flex min-w-0 items-center gap-2 lg:gap-3">
        <ContextChip />
        <ThemeSwitcher />
        <NotificationBell />
        <UserMenu />
      </div>
    </header>
  );
}
