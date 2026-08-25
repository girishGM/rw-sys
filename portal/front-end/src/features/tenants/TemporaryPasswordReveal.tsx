/**
 * T-034 — a narrow, self-contained rendering of BACKLOG.md B-01's contract for this screen
 * (Tenant Admin onboarding): *"the temporary password is shown once on screen ... hidden behind
 * an explicit Reveal click ... copy-to-clipboard ... never shown again."*
 *
 * A deliberate, near-identical copy of `features/countries/TemporaryPasswordReveal.tsx` (T-030's
 * own narrow instance of the same pattern) — this is **not** the general-purpose panel, which is
 * T-046's own scope (`front-end/src/features/users/PasswordRevealPanel.tsx`). T-046 is expected
 * to fold both call sites into its own generic component once it lands; noted for the reviewer,
 * mirroring the note in `tenant-admin-password.ts`.
 *
 * What this component still holds the line on, because they are the controls that make B-01's
 * trade-off survivable rather than merely convenient:
 *  - hidden until an explicit click (never visible the instant the page renders);
 *  - never written to `localStorage`, `sessionStorage`, the URL, or the TanStack Query cache —
 *    it lives only in the parent's React state, which this component never reaches past;
 *  - a persistent warning that this is the only time it will be shown.
 */
import { useState } from 'react';
import { Copy, Eye, EyeOff } from 'lucide-react';
import { Button } from '../../components/Button';
import { toast } from '../../components/toastActions';

export interface TemporaryPasswordRevealProps {
  email: string;
  temporaryPassword: string;
}

export function TemporaryPasswordReveal({
  email,
  temporaryPassword,
}: TemporaryPasswordRevealProps) {
  const [revealed, setRevealed] = useState(false);

  async function copyToClipboard(): Promise<void> {
    try {
      await navigator.clipboard.writeText(temporaryPassword);
      toast.success('Password copied to clipboard');
    } catch {
      toast.error('Could not copy — select and copy the password manually');
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-card border border-warning-200 bg-warning-50 p-4">
      <p className="text-sm font-medium text-warning-900">
        Tenant Admin account created for {email}
      </p>
      <p className="text-xs text-warning-800">
        This password will not be shown again. Share it securely and ask the user to change it at
        first login.
      </p>
      <div className="flex items-center gap-2">
        <code
          className="flex-1 rounded-control border border-warning-300 bg-white px-3 py-2 font-mono text-sm text-slate-900"
          data-testid="temporary-password-value"
        >
          {revealed ? temporaryPassword : '•'.repeat(temporaryPassword.length)}
        </code>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setRevealed((current) => !current)}
          aria-pressed={revealed}
        >
          {revealed ? (
            <EyeOff className="size-4" aria-hidden="true" />
          ) : (
            <Eye className="size-4" aria-hidden="true" />
          )}
          {revealed ? 'Hide' : 'Reveal'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void copyToClipboard()}
          disabled={!revealed}
        >
          <Copy className="size-4" aria-hidden="true" />
          Copy
        </Button>
      </div>
    </div>
  );
}
