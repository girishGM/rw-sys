import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '../../src/components/Button';

describe('Button', () => {
  it('TC-1: renders in its default state with no console errors', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('is keyboard reachable and invokes onClick on Enter/Space via native button semantics', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click me</Button>);
    await user.tab();
    expect(screen.getByRole('button')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('sets aria-busy and disables the control while isLoading', () => {
    render(<Button isLoading>Save</Button>);
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
  });

  it('carries a visible-focus utility class', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button').className).toMatch(/focus-visible:outline/);
  });
});
