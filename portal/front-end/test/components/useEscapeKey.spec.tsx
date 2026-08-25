import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEscapeKey } from '../../src/components/internal/useEscapeKey';
import { Modal } from '../../src/components/Modal';
import { MultiSelect, type MultiSelectOption } from '../../src/components/MultiSelect';

const COUNTRY_OPTIONS: MultiSelectOption[] = [
  { value: 'IN', label: 'India' },
  { value: 'ID', label: 'Indonesia' },
];

/**
 * T-075 — Escape key inside an open MultiSelect closes the enclosing Modal too, discarding
 * whatever was in progress. `Modal` and `MultiSelect` each call `useEscapeKey` independently;
 * before the fix, both fired on a single `Escape` press because neither was aware of the other.
 */
function AssignCountriesDialog({
  onClose,
  onCloseSpy,
}: {
  onClose: () => void;
  onCloseSpy: () => void;
}) {
  const [value, setValue] = useState<string[]>([]);
  return (
    <Modal
      open
      onClose={() => {
        onCloseSpy();
        onClose();
      }}
      title="Assign countries"
    >
      <MultiSelect label="Countries" options={COUNTRY_OPTIONS} value={value} onChange={setValue} />
    </Modal>
  );
}

describe('useEscapeKey — layered activation (T-075)', () => {
  it('TC-1 (unfixed-code repro, now expected to pass): pressing Escape while a MultiSelect dropdown is open inside a Modal closes only the dropdown, not the Modal', async () => {
    const user = userEvent.setup();
    const onCloseSpy = vi.fn();
    render(<AssignCountriesDialog onClose={vi.fn()} onCloseSpy={onCloseSpy} />);

    await screen.findByRole('dialog', { name: 'Assign countries' });
    await user.click(screen.getByRole('button', { name: /Countries/ }));
    await user.click(screen.getByRole('option', { name: 'India' }));
    expect(screen.getByRole('option', { name: 'India' })).toHaveAttribute('aria-selected', 'true');

    // TC-3: the regression case — this is exactly what golden-journey.spec.ts had to work
    // around (clicking the dialog heading instead of pressing Escape).
    await user.keyboard('{Escape}');

    // The dropdown closed...
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    // ...but the dialog itself, and the in-progress selection, must survive.
    expect(screen.getByRole('dialog', { name: 'Assign countries' })).toBeInTheDocument();
    expect(onCloseSpy).not.toHaveBeenCalled();
  });

  it('TC-2/TC-4: a second Escape press, with the dropdown already closed, still closes the Modal — the fix must not swallow Escape for the outer layer once it is top-of-stack again', async () => {
    const user = userEvent.setup();
    const onCloseSpy = vi.fn();
    render(<AssignCountriesDialog onClose={vi.fn()} onCloseSpy={onCloseSpy} />);

    await screen.findByRole('dialog', { name: 'Assign countries' });
    await user.click(screen.getByRole('button', { name: /Countries/ }));
    await user.click(screen.getByRole('option', { name: 'India' }));
    await user.keyboard('{Escape}'); // closes the dropdown only (see previous test)
    expect(onCloseSpy).not.toHaveBeenCalled();

    await user.keyboard('{Escape}'); // now the Modal is top-of-stack again
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
  });

  it('TC-4: adjacent behaviour is unchanged — a single active instance still fires on Escape', () => {
    const onEscape = vi.fn();
    render(<HookProbe onEscape={onEscape} active />);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('TC-4: adjacent behaviour is unchanged — an inactive instance does not fire on Escape', () => {
    const onEscape = vi.fn();
    render(<HookProbe onEscape={onEscape} active={false} />);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('unit-level: with two simultaneously active hooks, only the later-activated one fires', () => {
    const outer = vi.fn();
    const inner = vi.fn();

    const { result: outerHook } = renderHook(() => useEscapeKey(outer, true));
    const { result: innerHook } = renderHook(() => useEscapeKey(inner, true));
    void outerHook;
    void innerHook;

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('unit-level: once the later-activated hook deactivates, the earlier one resumes handling Escape', () => {
    const outer = vi.fn();
    const inner = vi.fn();

    renderHook(() => useEscapeKey(outer, true));
    const { unmount } = renderHook(() => useEscapeKey(inner, true));
    unmount();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(outer).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();
  });
});

function HookProbe({ onEscape, active }: { onEscape: () => void; active: boolean }) {
  useEscapeKey(onEscape, active);
  return null;
}
