import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { WidgetBoundary } from '../../../src/features/dashboard/widgets/WidgetBoundary';

function Bomb(): never {
  throw new Error('render blew up');
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  cleanup();
});

describe('WidgetBoundary', () => {
  it('renders children normally when nothing throws', () => {
    render(
      <WidgetBoundary label="Countries">
        <p>real content</p>
      </WidgetBoundary>,
    );
    expect(screen.getByText('real content')).toBeInTheDocument();
  });

  it('catches a render-time throw and shows the shared error tile instead of crashing', () => {
    render(
      <WidgetBoundary label="Countries">
        <Bomb />
      </WidgetBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load Countries.");
  });

  it('logs the crash to the console rather than swallowing it silently', () => {
    render(
      <WidgetBoundary label="Countries">
        <Bomb />
      </WidgetBoundary>,
    );
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
