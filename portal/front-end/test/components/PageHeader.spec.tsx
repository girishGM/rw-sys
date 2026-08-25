import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageHeader } from '../../src/components/PageHeader';

describe('PageHeader', () => {
  it('TC-1: renders title as an h1, with description and actions', () => {
    render(
      <PageHeader
        title="Campaigns"
        description="Manage reward campaigns"
        actions={<button type="button">New campaign</button>}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Campaigns' })).toBeInTheDocument();
    expect(screen.getByText('Manage reward campaigns')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New campaign' })).toBeInTheDocument();
  });
});
