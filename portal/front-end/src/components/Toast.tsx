import { Toaster as SonnerToaster } from 'sonner';

/**
 * T-021 TC-10 — built on `sonner` (already a workspace dependency), which implements the
 * `aria-live="polite"` announcement region, auto-dismiss timing and keyboard
 * dismissal (`Escape`, or `Tab` to the close button) this component needs — the same
 * "don't hand-roll what a maintained primitive already solves correctly" reasoning
 * 04-FRONTEND.md §7 applies to Radix elsewhere in this task applies here too.
 *
 * `Toaster` is mounted once near the app root (`AppShell`, T-023); call `toast(...)` from
 * `./toastActions` anywhere to enqueue a notification (kept in its own module, not
 * re-exported here, so this file only exports a component — see
 * `react-refresh/only-export-components`).
 */
export function Toaster() {
  return (
    <SonnerToaster
      position="top-right"
      richColors={false}
      closeButton
      toastOptions={{
        classNames: {
          toast: 'rounded-card border border-slate-200 bg-white shadow-popover font-sans text-sm',
          title: 'text-slate-900 font-medium',
          description: 'text-slate-500',
          success: 'border-success-200 [&_[data-icon]]:text-success-600',
          error: 'border-danger-200 [&_[data-icon]]:text-danger-600',
          warning: 'border-warning-200 [&_[data-icon]]:text-warning-600',
          info: 'border-primary-200 [&_[data-icon]]:text-primary-600',
        },
      }}
    />
  );
}
