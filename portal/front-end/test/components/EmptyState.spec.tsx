import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from '../../src/components/EmptyState';

describe('EmptyState', () => {
  it('TC-6: shows the caller-supplied message', () => {
    render(<EmptyState message="No campaigns yet" />);
    expect(screen.getByText('No campaigns yet')).toBeInTheDocument();
  });

  it('shows an optional description and action', () => {
    render(
      <EmptyState
        message="No campaigns yet"
        description="Create your first campaign to get started."
        action={<button type="button">Create campaign</button>}
      />,
    );
    expect(screen.getByText('Create your first campaign to get started.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create campaign' })).toBeInTheDocument();
  });
});
