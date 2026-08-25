/**
 * T-049 — `OptionChips`: TC-2, TC-3, TC-16 and the two properties implementation note 1 rests on —
 * every chip comes from the server's own list, and selecting one sends the server's own
 * `optionId`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentOption } from '@reward-portal/shared';
import { OptionChips } from '../../../src/features/campaign-agent/OptionChips';
import { MERCHANT_OPTIONS, RULE_OPTIONS } from './fixtures';

afterEach(() => {
  cleanup();
});

function renderChips(
  kind: 'merchants' | 'activities' | 'rules' | 'rewards',
  options: readonly AgentOption[],
  disabled = false,
) {
  const onChoose = vi.fn();
  render(<OptionChips kind={kind} options={options} disabled={disabled} onChoose={onChoose} />);
  return { onChoose };
}

describe('TC-2 — merchant options', () => {
  it('renders exactly the options the server sent, as real buttons in a named group', () => {
    renderChips('merchants', MERCHANT_OPTIONS.merchants);

    const group = screen.getByRole('group', { name: 'Merchants you can choose' });
    const chips = within(group).getAllByRole('button');
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'Acme ElectronicsACME-EL',
      'TechWorld KLTW-KL',
    ]);
  });

  it('renders nothing at all when the turn offered no options', () => {
    const { container } = render(<OptionChips kind="merchants" options={[]} onChoose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('sends the chosen merchants with their server-minted optionIds — the maker types no id', async () => {
    const user = userEvent.setup();
    const { onChoose } = renderChips('merchants', MERCHANT_OPTIONS.merchants);

    await user.click(screen.getByRole('button', { name: /Acme Electronics/ }));
    await user.click(screen.getByRole('button', { name: /TechWorld KL/ }));
    await user.click(screen.getByRole('button', { name: 'Use these merchants' }));

    expect(onChoose).toHaveBeenCalledWith('merchants', [
      MERCHANT_OPTIONS.merchants[0],
      MERCHANT_OPTIONS.merchants[1],
    ]);
    // There is no text input on this control at all — nothing to type an id into.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('announces multi-select state with aria-pressed rather than colour alone', async () => {
    const user = userEvent.setup();
    renderChips('merchants', MERCHANT_OPTIONS.merchants);

    const chip = screen.getByRole('button', { name: /Acme Electronics/ });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    await user.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
  });

  it('cannot submit an empty selection', () => {
    renderChips('merchants', MERCHANT_OPTIONS.merchants);
    expect(screen.getByRole('button', { name: 'Use these merchants' })).toBeDisabled();
  });

  it('disables every chip while a turn is in flight', () => {
    renderChips('merchants', MERCHANT_OPTIONS.merchants, true);

    for (const chip of screen.getAllByRole('button')) {
      expect(chip).toBeDisabled();
    }
  });
});

describe('TC-3 / TC-4 — rule options', () => {
  it('shows the version number on every rule chip', () => {
    renderChips('rules', RULE_OPTIONS.rules);

    expect(screen.getByText('MIN_SPEND_TIER · v3')).toBeInTheDocument();
    expect(screen.getByText('SPEND_TIER · v2')).toBeInTheDocument();
  });

  it('a rule is chosen with one click, and the selection carries its version', async () => {
    const user = userEvent.setup();
    const { onChoose } = renderChips('rules', RULE_OPTIONS.rules);

    await user.click(screen.getByRole('button', { name: /Minimum spend tier/ }));

    expect(onChoose).toHaveBeenCalledWith('rules', [RULE_OPTIONS.rules[0]]);
    // Single-select: no confirm step, and no `aria-pressed` — the chip is an action, not a toggle.
    expect(screen.queryByRole('button', { name: 'Use this rule' })).not.toBeInTheDocument();
  });
});

describe('TC-16 — keyboard only', () => {
  it('every chip and the confirm button are reachable by Tab and operable by Enter', async () => {
    const user = userEvent.setup();
    const { onChoose } = renderChips('merchants', MERCHANT_OPTIONS.merchants);

    await user.tab();
    expect(screen.getByRole('button', { name: /Acme Electronics/ })).toHaveFocus();
    await user.keyboard('{Enter}');

    await user.tab();
    expect(screen.getByRole('button', { name: /TechWorld KL/ })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Use these merchants' })).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(onChoose).toHaveBeenCalledWith('merchants', [MERCHANT_OPTIONS.merchants[0]]);
  });
});
