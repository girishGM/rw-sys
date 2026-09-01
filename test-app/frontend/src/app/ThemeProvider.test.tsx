/**
 * T-005 — TC-5 (default is always `bright`, no persistence to reset from), plus the
 * `data-theme`-attribute mechanism every `tokens.css` block relies on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from './ThemeProvider';
import { THEMES, useTheme, type Theme } from './useTheme';

function Probe() {
  const { theme, setTheme } = useTheme();
  return (
    <div>
      <div data-testid="theme">{theme}</div>
      {THEMES.map((option) => (
        <button key={option} type="button" onClick={() => setTheme(option)}>
          {option}
        </button>
      ))}
    </div>
  );
}

function documentThemeAttribute(): string | null {
  return document.documentElement.getAttribute('data-theme');
}

function suppressExpectedReactErrorLogging() {
  return vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

describe('ThemeProvider', () => {
  it('defaults to bright on first render, with no fetch/persistence involved', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('bright');
    expect(documentThemeAttribute()).toBe('bright');
  });

  it.each(THEMES.filter((t): t is Theme => t !== 'bright'))(
    'setTheme(%s) updates context state and the document data-theme attribute, synchronously',
    async (theme) => {
      const user = userEvent.setup();
      render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );

      await user.click(screen.getByRole('button', { name: theme }));

      expect(screen.getByTestId('theme')).toHaveTextContent(theme);
      expect(documentThemeAttribute()).toBe(theme);
    },
  );

  it('useTheme() throws a clear error when used outside a <ThemeProvider>', () => {
    const consoleSpy = suppressExpectedReactErrorLogging();
    expect(() => render(<Probe />)).toThrow('useTheme() must be called within a <ThemeProvider>.');
    consoleSpy.mockRestore();
  });
});
