/**
 * T-006 — the mockup's "glass profile/customer chip (avatar initials + name + chevron)"
 * (UI-UX-DESIGN.md "Header"), made into a real dropdown (`@radix-ui/react-select`, already a
 * frontend dependency — see `package.json`) that actually switches the selected customer (this
 * task's Scope: "not just visual, it must actually switch customers"), not just a static chip.
 *
 * Renders its own trigger content (avatar + name) rather than `Select.Value`'s default text-only
 * mirroring, so the trigger can show the same avatar-chip visual the mockup specifies — Radix
 * does not require `Select.Value` to be present; the accessible name comes from `aria-label`
 * instead.
 */
import * as Select from '@radix-ui/react-select';
import { cx } from './internal/cx';
import { ChevronDownIcon, CheckCircleIcon } from './icons';
import { useCustomer } from '../app/useCustomer';

export interface CustomerSwitcherProps {
  className?: string;
}

function Avatar({ initials, size = 'md' }: { initials: string; size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'flex items-center justify-center rounded-full bg-accent-soft font-bold text-accent-strong',
        size === 'md' ? 'h-8 w-8 text-xs' : 'h-6 w-6 text-[10px]',
      )}
    >
      {initials}
    </span>
  );
}

export function CustomerSwitcher({ className }: CustomerSwitcherProps) {
  const { customers, customerId, customer, setCustomerId, isLoading } = useCustomer();

  if (isLoading || !customer) {
    return (
      <div
        className={cx('glass flex h-11 items-center gap-2 rounded-full px-3', className)}
        aria-hidden="true"
      >
        <span className="h-8 w-8 rounded-full bg-surface-2" />
        <span className="text-sm text-ink-muted">Loading…</span>
      </div>
    );
  }

  return (
    <Select.Root value={customerId ?? undefined} onValueChange={setCustomerId}>
      {/* T-011: `data-[state=open]` alone left plain Tab focus with zero visible indicator
          (Tailwind's `outline-none` sets a transparent 2px outline, not `outline: 0`) —
          `focus-visible:ring-2` covers the keyboard-focused-but-closed case too. */}
      <Select.Trigger
        aria-label={`Switch customer (currently ${customer.displayName})`}
        className={cx(
          'glass flex h-11 items-center gap-2 rounded-full px-3 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:ring-2 data-[state=open]:ring-accent',
          className,
        )}
      >
        <Avatar initials={customer.avatarInitials} />
        <span className="font-body text-sm font-semibold text-ink">{customer.displayName}</span>
        <Select.Icon asChild>
          <ChevronDownIcon className="h-4 w-4 text-ink-muted" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="glass z-50 overflow-hidden rounded-card p-1"
          position="popper"
          sideOffset={8}
        >
          <Select.Viewport>
            {customers.map((entry) => (
              <Select.Item
                key={entry.id}
                value={entry.id}
                className="flex cursor-pointer items-center gap-2 rounded-chip px-3 py-2 text-sm text-ink outline-none data-[highlighted]:bg-accent-soft"
              >
                <Avatar initials={entry.avatarInitials} size="sm" />
                <Select.ItemText>{entry.displayName}</Select.ItemText>
                <Select.ItemIndicator className="ml-auto">
                  <CheckCircleIcon className="h-4 w-4 text-accent" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
