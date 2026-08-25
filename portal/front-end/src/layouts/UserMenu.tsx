/**
 * T-023 — the avatar menu (04-FRONTEND.md §1: "Role badge in the avatar menu, so a user can
 * always confirm their own capabilities"). Display name, role badge, log out — nothing else;
 * this task's scope stops at the shell, `/me` profile editing is not built here.
 */
import { useRef, useState } from 'react';
import { ChevronDown, LogOut } from 'lucide-react';
import type { SharedPortalRole } from '@reward-portal/shared';
import { Badge } from '../components/Badge';
import { cx } from '../components/internal/cx';
import { useOutsideClick } from '../components/internal/useOutsideClick';
import { useEscapeKey } from '../components/internal/useEscapeKey';
import { useBootstrap, useLogout } from '../auth/useBootstrap';

const ROLE_LABEL: Record<SharedPortalRole, string> = {
  super_admin: 'Super Admin',
  country_admin: 'Country Admin',
  tenant_admin: 'Tenant Admin',
  maker: 'Maker',
  checker: 'Checker',
  merchant: 'Merchant',
};

export function UserMenu() {
  const { user } = useBootstrap();
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useOutsideClick([containerRef], () => setOpen(false), open);
  useEscapeKey(() => setOpen(false), open);

  if (!user) return null;

  const roleLabel = ROLE_LABEL[user.role];

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={cx(
          'flex items-center gap-2 rounded-control px-2 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500',
        )}
      >
        <span className="flex size-7 items-center justify-center rounded-full bg-primary-100 text-xs font-semibold text-primary-700">
          {initialsOf(user.displayName)}
        </span>
        <span className="hidden lg:inline">{user.displayName}</span>
        <ChevronDown
          aria-hidden="true"
          className={cx('size-4 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={`${user.displayName} account menu`}
          className="absolute right-0 top-full z-10 mt-1 w-56 rounded-card border border-slate-200 bg-white p-1 shadow-popover"
        >
          <div className="px-3 py-2">
            <p className="text-sm font-medium text-slate-900">{user.displayName}</p>
            <Badge tone="primary" className="mt-1">
              {roleLabel}
            </Badge>
          </div>
          <div className="my-1 border-t border-slate-100" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void logout();
            }}
            className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
          >
            <LogOut className="size-4" aria-hidden="true" />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

function initialsOf(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  const initials = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '');
  return initials.join('') || '?';
}
