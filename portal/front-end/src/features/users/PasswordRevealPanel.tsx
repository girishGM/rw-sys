/**
 * T-046 — the general-purpose one-time password reveal panel (BACKLOG.md B-01, implementation
 * note 8), replacing `TemporaryPasswordReveal.tsx` (T-035's own narrow instance — that
 * component's header names this file by its exact path as the thing expected to replace it).
 * `AddUserModal.tsx` and `UserDetailPage.tsx` are this feature's two call sites; both now render
 * this component instead.
 *
 * Every bullet of implementation note 8, in one place:
 *
 *  - **Hidden until Reveal is clicked** — never visible the instant the panel mounts.
 *  - **Copy-to-clipboard**, disabled until revealed (nothing to copy from a masked value anyway).
 *  - **The exact warning text** the task file specifies, word for word.
 *  - **Auto-hide after 60 seconds** (`AUTO_HIDE_MS`) — a `setTimeout` armed on every reveal and
 *    cleared on hide/unmount, so a panel left open on an unattended screen does not keep showing
 *    the value indefinitely.
 *  - **A confirmation checkbox gates the only dismiss affordance this component renders.** The
 *    panel owns its own "Done" button and its own `onDismiss` callback rather than trusting the
 *    caller's surrounding UI (a `Modal`'s backdrop click, `Esc`, or its own × button) to be
 *    gate-able — `front-end/src/components/Modal.tsx` is outside this task's file scope
 *    (AGENT-PROTOCOL R9) and offers no such gate itself. `AddUserModal.tsx` closes the loop on its
 *    side by making its own `onClose` a no-op while this panel is showing and undismissed, so
 *    every dismissal path — this button, the modal's ×, its backdrop, `Esc` — funnels through the
 *    one gated callback (TC-20).
 *  - **Never `localStorage`, `sessionStorage`, the URL, or the TanStack Query cache.** The value
 *    lives only in this component's own React state and the caller's, both of which this
 *    component never persists anywhere (TC-21/TC-22 — a browser-back after dismiss cannot recover
 *    it, because nothing outside this render ever held it).
 */
import { useEffect, useRef, useState } from 'react';
import { Copy, Eye, EyeOff } from 'lucide-react';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { toast } from '../../components/toastActions';

/** Implementation note 8: "auto-hide after 60 seconds." */
export const AUTO_HIDE_MS = 60_000;

export interface PasswordRevealPanelProps {
  email: string;
  temporaryPassword: string;
  /** "created" (default) or "reset" — the only wording difference between the two call sites. */
  action?: 'created' | 'reset';
  /** Called only once the confirmation checkbox is ticked and Done is clicked (TC-20). */
  onDismiss: () => void;
}

export function PasswordRevealPanel({
  email,
  temporaryPassword,
  action = 'created',
  onDismiss,
}: PasswordRevealPanelProps) {
  const [revealed, setRevealed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    },
    [],
  );

  function clearHideTimer(): void {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }

  function reveal(): void {
    setRevealed(true);
    clearHideTimer();
    hideTimer.current = setTimeout(() => setRevealed(false), AUTO_HIDE_MS);
  }

  function hide(): void {
    setRevealed(false);
    clearHideTimer();
  }

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
        {action === 'created' ? 'Account created for' : 'Password reset for'} {email}
      </p>
      <p className="text-xs text-warning-800">
        This password will not be shown again. Share it securely and ask the user to change it
        within 72 hours.
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
          onClick={() => (revealed ? hide() : reveal())}
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
      <Checkbox
        label="I have securely shared this password and the user knows to change it"
        checked={confirmed}
        onChange={(event) => setConfirmed(event.target.checked)}
      />
      <div className="flex justify-end">
        <Button type="button" onClick={onDismiss} disabled={!confirmed}>
          Done
        </Button>
      </div>
    </div>
  );
}
