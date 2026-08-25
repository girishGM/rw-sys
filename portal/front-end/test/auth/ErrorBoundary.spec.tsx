import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary } from '../../src/app/ErrorBoundary';

function Bomb(): never {
  throw new Error('kaboom — internal stack detail that must never reach the page');
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('TC-15: catches a render error and shows a recovery page instead of white-screening', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('never renders the raw error message on the page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(document.body.textContent).not.toContain('internal stack detail');
  });

  it('the Reload button navigates to the app root', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // jsdom's `window.location` is non-configurable in this environment, so `vi.spyOn`
    // cannot replace `assign` directly — swap the whole object for the duration of the test.
    const originalLocation = window.location;
    const assignMock = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign: assignMock },
    });

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(assignMock).toHaveBeenCalledWith('/');

    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('renders children normally when nothing throws', () => {
    render(
      <ErrorBoundary>
        <div>All good</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('All good')).toBeInTheDocument();
  });
});
