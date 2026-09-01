/**
 * T-005 — TC-4: clicking a swatch fires `setTheme`, updates the `data-theme` attribute, with no
 * page reload (no `window.location` involved anywhere in this component).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '../app/ThemeProvider';
import { ThemeSwitcher } from './ThemeSwitcher';

function renderSwitcher() {
  return render(
    <ThemeProvider>
      <ThemeSwitcher />
    </ThemeProvider>,
  );
}

describe('ThemeSwitcher', () => {
  it('renders one swatch button per theme, Bright active by default', () => {
    renderSwitcher();
    const group = screen.getByRole('group', { name: 'Choose a theme' });
    expect(group).toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Bright' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Midnight' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('button', { name: 'Celebration' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('TC-4: clicking a swatch applies that theme immediately, no reload', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(screen.getByRole('button', { name: 'Midnight' }));

    expect(document.documentElement.getAttribute('data-theme')).toBe('midnight');
    expect(screen.getByRole('button', { name: 'Midnight' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Bright' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('switching again updates which single swatch is active', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(screen.getByRole('button', { name: 'Celebration' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('celebration');

    await user.click(screen.getByRole('button', { name: 'Bright' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('bright');
    expect(screen.getByRole('button', { name: 'Celebration' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});
