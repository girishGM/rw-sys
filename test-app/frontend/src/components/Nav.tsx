/**
 * T-006 — the app header (UI-UX-DESIGN.md "Header"): logo mark + wordmark, a glass pill-shaped
 * nav (active item gets `--accent-soft` bg), the theme switcher (T-005), and the customer
 * switcher (`CustomerSwitcher.tsx`). "This header shape and its elements are identical on every
 * page" per that spec, so it's mounted once by `app/router.tsx`'s root layout, not per-page.
 *
 * Responsive per `UI-UX-DESIGN.md` "Responsive rules": below the `lg` breakpoint the pill nav,
 * theme swatches and customer switcher move behind a hamburger into a real drawer
 * (`@radix-ui/react-dialog`, already a frontend dependency), not just hidden with CSS — the
 * drawer has real open/close state, closes on Escape/overlay click/route change, and traps focus
 * (Radix's own `FocusScope`) while open, per this task's implementation notes.
 *
 * T-011: the full nav + theme-swatch cluster + customer chip genuinely does not fit in the
 * UI-UX-DESIGN.md "tablet" reference width (~768px, Tailwind's own `md` breakpoint) — measured
 * ~98px of horizontal overflow with the shortest demo customer name selected, worse with longer
 * ones ("Aisha Rahman"). Rather than shave padding to a width that only barely fits today's fixed
 * demo names (and silently breaks again for any longer customer name), the collapse threshold
 * moved to `lg` (1024px), so ~768px reliably gets the already-correct, already-tested compact
 * header (this exact drawer, confirmed to contain everything the desktop header shows).
 */
import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { NavLink } from 'react-router-dom';
import { cx } from './internal/cx';
import { GiftIcon, MenuIcon, XIcon } from './icons';
import { ThemeSwitcher } from './ThemeSwitcher';
import { CustomerSwitcher } from './CustomerSwitcher';
import { useCustomer } from '../app/useCustomer';

interface NavItem {
  readonly to: string;
  readonly label: string;
  /** Only `/` needs exact matching — every other item's `to` is also a valid prefix for its own
   * sub-routes (e.g. `/campaigns` should stay active on `/campaigns/:code` too). */
  readonly end?: boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/campaigns', label: 'Campaigns' },
  { to: '/rewards', label: 'My Rewards' },
  { to: '/activity', label: 'Activity' },
];

function navLinkClassName({ isActive }: { isActive: boolean }): string {
  return cx(
    'rounded-full px-4 py-2 text-sm font-semibold transition-colors',
    isActive ? 'bg-accent-soft text-accent-strong' : 'text-ink-muted hover:text-ink',
  );
}

function drawerNavLinkClassName({ isActive }: { isActive: boolean }): string {
  return cx(
    'rounded-chip px-4 py-3 text-sm font-semibold transition-colors',
    isActive ? 'bg-accent-soft text-accent-strong' : 'text-ink-muted hover:text-ink',
  );
}

function Logo() {
  return (
    <NavLink to="/" aria-label="Perks home" className="flex shrink-0 items-center gap-2">
      <span className="flex h-9 w-9 items-center justify-center rounded-chip bg-gradient-to-br from-accent to-secondary text-white">
        <GiftIcon className="h-5 w-5" />
      </span>
      <span className="font-heading text-lg font-bold text-ink">Perks</span>
    </NavLink>
  );
}

export function Nav() {
  const { customer } = useCustomer();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40">
      <div className="mx-auto flex max-w-[1180px] items-center justify-between gap-4 px-4 py-4 sm:px-8">
        <Logo />

        <nav
          aria-label="Primary"
          className="glass hidden items-center gap-1 rounded-full p-1.5 lg:flex"
        >
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={navLinkClassName}>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="hidden items-center gap-3 lg:flex">
          <ThemeSwitcher />
          <CustomerSwitcher />
        </div>

        <div className="flex items-center gap-2 lg:hidden">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-soft text-xs font-bold text-accent-strong"
          >
            {customer?.avatarInitials ?? ''}
          </span>
          <button
            type="button"
            aria-label="Open menu"
            aria-haspopup="dialog"
            onClick={() => setDrawerOpen(true)}
            className="flex h-11 w-11 items-center justify-center rounded-full text-ink"
          >
            <MenuIcon className="h-5 w-5" />
          </button>
        </div>
      </div>

      <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 lg:hidden" />
          <Dialog.Content
            aria-describedby={undefined}
            className="glass fixed inset-y-0 right-0 z-50 flex w-[82%] max-w-xs flex-col gap-6 overflow-y-auto rounded-none p-6 lg:hidden"
          >
            <div className="flex items-center justify-between">
              <Dialog.Title className="font-heading text-lg font-bold text-ink">Menu</Dialog.Title>
              <Dialog.Close
                aria-label="Close menu"
                className="flex h-11 w-11 items-center justify-center rounded-full text-ink"
              >
                <XIcon className="h-5 w-5" />
              </Dialog.Close>
            </div>

            <nav aria-label="Primary" className="flex flex-col gap-1">
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={() => setDrawerOpen(false)}
                  className={drawerNavLinkClassName}
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>

            <div className="flex flex-col gap-3">
              <span className="font-body text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Theme
              </span>
              <ThemeSwitcher />
            </div>

            <div className="flex flex-col gap-3">
              <span className="font-body text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Customer
              </span>
              <CustomerSwitcher />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </header>
  );
}
