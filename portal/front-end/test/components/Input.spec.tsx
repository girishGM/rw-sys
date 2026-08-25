import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Input } from '../../src/components/Input';

describe('Input', () => {
  it('every input is labelled and reachable by its label text', () => {
    render(<Input label="Email address" />);
    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
  });

  it('types into the field via keyboard', async () => {
    const user = userEvent.setup();
    render(<Input label="Email address" />);
    const input = screen.getByLabelText('Email address');
    await user.type(input, 'a@b.com');
    expect(input).toHaveValue('a@b.com');
  });

  it('wires aria-invalid and aria-describedby to the error message', () => {
    render(<Input label="Email address" error="Enter a valid email" />);
    const input = screen.getByLabelText('Email address');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const errorEl = screen.getByRole('alert');
    expect(errorEl).toHaveTextContent('Enter a valid email');
    expect(input.getAttribute('aria-describedby')).toContain(errorEl.id);
  });

  it('wires aria-describedby to a hint when there is no error', () => {
    render(<Input label="Email address" hint="We never share this" />);
    const input = screen.getByLabelText('Email address');
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('We never share this')).toBeInTheDocument();
  });
});
