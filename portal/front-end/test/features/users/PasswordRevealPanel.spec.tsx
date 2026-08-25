/**
 * T-046 — `PasswordRevealPanel`: TC-17…TC-22 and TC-25, the UI half of implementation note 8.
 * Same `axe-core`-against-jsdom approach `test/features/auth/a11y.spec.tsx` (T-024) and
 * `test/layouts/NotificationBell.spec.tsx` (fake timers + `userEvent`) already establish for this
 * workspace — see those files' own headers for why each technique is safe here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as axe from 'axe-core';
import { AUTO_HIDE_MS, PasswordRevealPanel } from '../../../src/features/users/PasswordRevealPanel';

// No `<Toaster/>` is mounted in these unit tests (same as the deleted `TemporaryPasswordReveal`
// suites this file replaces) — `sonner` is mocked so the copy-success/copy-failure branches are
// observable without one.
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

const EMAIL = 'new.user@example.invalid';
const PASSWORD = 'Xy9!kLmnpQ2*Zvwr4Tabcd7A';

let writeText: ReturnType<typeof vi.spyOn>;

const JSDOM_LAYOUT_DEPENDENT_RULES = ['color-contrast', 'color-contrast-enhanced'];

async function scan(container: HTMLElement, label: string) {
  const results = await axe.run(container, {
    rules: Object.fromEntries(JSDOM_LAYOUT_DEPENDENT_RULES.map((id) => [id, { enabled: false }])),
  });
  const violations = results.violations.map((v) => ({ id: v.id, help: v.help }));
  expect(violations, `${label}: axe-core violations`).toEqual([]);
}

function renderPanel(onDismiss = vi.fn()) {
  return {
    onDismiss,
    ...render(
      <PasswordRevealPanel email={EMAIL} temporaryPassword={PASSWORD} onDismiss={onDismiss} />,
    ),
  };
}

beforeEach(() => {
  // `navigator.clipboard` does not exist in jsdom on its own — `@testing-library/user-event`
  // installs the stub the first time `setup()` runs in this window (its own `Clipboard.js`
  // source), which is why this call comes before the spy below, not after it.
  userEvent.setup();
  writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  toastSuccess.mockClear();
  toastError.mockClear();
  // T-046 TC-21 — this file's whole point is *proving the password is never written here*, the
  // opposite of the violation AGENT-PROTOCOL R5 / the `no-restricted-globals` rule guards
  // against. Disabled deliberately and narrowly, not routed around via `window.localStorage`,
  // which the rule's own message explicitly says not to do ("never silently worked around").
  // eslint-disable-next-line no-restricted-globals -- T-046 TC-21: test-only assertion of absence.
  localStorage.clear();
  // eslint-disable-next-line no-restricted-globals -- T-046 TC-21: test-only assertion of absence.
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('T-046 TC-17: hidden on mount', () => {
  it('masks the password behind dots and never renders the plaintext into the DOM', () => {
    renderPanel();
    const value = screen.getByTestId('temporary-password-value');
    expect(value.textContent).not.toContain(PASSWORD);
    expect(value.textContent).toMatch(/^•+$/);
    expect(document.body.innerHTML).not.toContain(PASSWORD);
    expect(screen.getByRole('button', { name: /reveal/i })).toBeInTheDocument();
  });

  it('shows the exact 72-hour warning text (implementation note 8)', () => {
    renderPanel();
    expect(
      screen.getByText(
        'This password will not be shown again. Share it securely and ask the user to change it within 72 hours.',
      ),
    ).toBeInTheDocument();
  });
});

describe('T-046 TC-18: reveal', () => {
  it('shows the plaintext and lets copy succeed once revealed', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /reveal/i }));

    expect(screen.getByTestId('temporary-password-value')).toHaveTextContent(PASSWORD);
    const copyButton = screen.getByRole('button', { name: /copy/i });
    expect(copyButton).toBeEnabled();

    await user.click(copyButton);
    expect(writeText).toHaveBeenCalledWith(PASSWORD);
    await vi.waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Password copied to clipboard'),
    );
  });

  it('copy is disabled before the password has been revealed', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: /copy/i })).toBeDisabled();
  });

  it('a clipboard failure is surfaced rather than swallowed', async () => {
    writeText.mockRejectedValueOnce(new Error('clipboard denied'));
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /reveal/i }));
    await user.click(screen.getByRole('button', { name: /copy/i }));

    await vi.waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'Could not copy — select and copy the password manually',
      ),
    );
  });

  it('Hide re-masks the password on demand', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /reveal/i }));
    expect(screen.getByTestId('temporary-password-value')).toHaveTextContent(PASSWORD);

    await user.click(screen.getByRole('button', { name: /hide/i }));
    expect(screen.getByTestId('temporary-password-value')).not.toHaveTextContent(PASSWORD);
  });
});

describe('T-046 TC-19: auto-hide after 60 seconds', () => {
  it('re-masks the password on its own, unprompted', () => {
    vi.useFakeTimers();
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /reveal/i }));
    expect(screen.getByTestId('temporary-password-value')).toHaveTextContent(PASSWORD);

    act(() => {
      vi.advanceTimersByTime(AUTO_HIDE_MS - 1);
    });
    expect(screen.getByTestId('temporary-password-value')).toHaveTextContent(PASSWORD);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId('temporary-password-value')).not.toHaveTextContent(PASSWORD);
  });

  it('re-arms the timer on every fresh reveal rather than stacking timers', () => {
    vi.useFakeTimers();
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /reveal/i })); // reveal
    act(() => vi.advanceTimersByTime(AUTO_HIDE_MS - 1));
    fireEvent.click(screen.getByRole('button', { name: /hide/i })); // hide manually — clears the timer
    fireEvent.click(screen.getByRole('button', { name: /reveal/i })); // reveal again — fresh 60s

    act(() => vi.advanceTimersByTime(AUTO_HIDE_MS - 1));
    expect(screen.getByTestId('temporary-password-value')).toHaveTextContent(PASSWORD);

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId('temporary-password-value')).not.toHaveTextContent(PASSWORD);
  });

  it('clears its timer on unmount, so no state update fires after the component is gone', () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    const { unmount } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /reveal/i }));
    unmount();

    expect(clearSpy).toHaveBeenCalled();
    // No React "update on an unmounted component" warning: advancing time after unmount must not
    // throw or log — the effect cleanup already cancelled the pending setTimeout.
    expect(() => act(() => vi.advanceTimersByTime(AUTO_HIDE_MS))).not.toThrow();
  });
});

describe('T-046 TC-20: dismiss is gated by the confirmation checkbox', () => {
  it('Done is disabled until the checkbox is ticked, and onDismiss is not called', async () => {
    const user = userEvent.setup();
    const { onDismiss } = renderPanel();

    const done = screen.getByRole('button', { name: /done/i });
    expect(done).toBeDisabled();

    await user.click(done); // a disabled button ignores the click natively
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('Done becomes enabled, and calls onDismiss, once the checkbox is ticked', async () => {
    const user = userEvent.setup();
    const { onDismiss } = renderPanel();

    await user.click(screen.getByRole('checkbox'));
    const done = screen.getByRole('button', { name: /done/i });
    expect(done).toBeEnabled();

    await user.click(done);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('T-046 TC-21: never written to browser storage or the URL', () => {
  it('localStorage and sessionStorage stay empty through reveal, copy and dismiss', async () => {
    const user = userEvent.setup();
    const { onDismiss } = renderPanel();

    await user.click(screen.getByRole('button', { name: /reveal/i }));
    await user.click(screen.getByRole('button', { name: /copy/i }));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /done/i }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line no-restricted-globals -- T-046 TC-21: test-only assertion of absence.
    expect(localStorage.length).toBe(0);
    // eslint-disable-next-line no-restricted-globals -- T-046 TC-21: test-only assertion of absence.
    expect(sessionStorage.length).toBe(0);
    expect(window.location.href).not.toContain(PASSWORD);
    expect(document.cookie).not.toContain(PASSWORD);
  });
});

describe('T-046: reset wording', () => {
  it('renders the reset-specific heading for action="reset"', () => {
    render(
      <PasswordRevealPanel
        email={EMAIL}
        temporaryPassword={PASSWORD}
        action="reset"
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(`Password reset for ${EMAIL}`)).toBeInTheDocument();
  });
});

describe('T-046 TC-25: axe-core, zero violations, reveal is keyboard-operable', () => {
  it('hidden state', async () => {
    const { container } = renderPanel();
    await scan(container, 'PasswordRevealPanel — hidden');
  });

  it('revealed state, checkbox ticked', async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    await user.click(screen.getByRole('button', { name: /reveal/i }));
    await user.click(screen.getByRole('checkbox'));
    await scan(container, 'PasswordRevealPanel — revealed');
  });

  it('Reveal is reachable and activatable by keyboard alone', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.tab(); // Reveal is the first focusable control in the panel
    expect(screen.getByRole('button', { name: /reveal/i })).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(screen.getByTestId('temporary-password-value')).toHaveTextContent(PASSWORD);
  });
});
