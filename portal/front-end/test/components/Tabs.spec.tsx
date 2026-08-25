import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tabs } from '../../src/components/Tabs';

const ITEMS = [
  { value: 'details', label: 'Details', panel: <div>Details panel</div> },
  { value: 'history', label: 'History', panel: <div>History panel</div> },
  { value: 'audit', label: 'Audit', panel: <div>Audit panel</div> },
];

function renderTabs(value: string, onChange = vi.fn()) {
  return { onChange, ...render(<Tabs value={value} onChange={onChange} items={ITEMS} />) };
}

/** Stateful wrapper — mirrors how a real controlled consumer re-renders after `onChange`. */
function ControlledTabs({
  onSelect,
  initial = 'details',
}: {
  onSelect?: (v: string) => void;
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Tabs
      value={value}
      onChange={(next) => {
        setValue(next);
        onSelect?.(next);
      }}
      items={ITEMS}
    />
  );
}

describe('Tabs', () => {
  it('TC-1: renders the tablist, the active tab selected, and its panel', () => {
    renderTabs('details');
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('Details panel')).toBeInTheDocument();
  });

  it('only the active tab is in the Tab order (roving tabindex)', () => {
    renderTabs('details');
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('tabindex', '-1');
  });

  it('ArrowRight wraps from the last tab back to the first', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ControlledTabs initial="audit" onSelect={onSelect} />);
    screen.getByRole('tab', { name: 'Audit' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onSelect).toHaveBeenCalledWith('details');
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveFocus();
  });

  it('ArrowLeft wraps from the first tab back to the last', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ControlledTabs initial="details" onSelect={onSelect} />);
    screen.getByRole('tab', { name: 'Details' }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(onSelect).toHaveBeenCalledWith('audit');
    expect(screen.getByRole('tab', { name: 'Audit' })).toHaveFocus();
  });

  it('the panel is linked to its tab via aria-controls/aria-labelledby', () => {
    renderTabs('details');
    const tab = screen.getByRole('tab', { name: 'Details' });
    const panel = screen.getByRole('tabpanel');
    expect(tab).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', tab.id);
  });
});
