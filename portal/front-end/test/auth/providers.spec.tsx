import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useQuery } from '@tanstack/react-query';
import { AppProviders } from '../../src/app/providers';

function Probe() {
  const { data } = useQuery({ queryKey: ['probe'], queryFn: () => Promise.resolve('ready') });
  return <div>{data ?? 'pending'}</div>;
}

describe('AppProviders', () => {
  it('supplies a QueryClientProvider so descendants can call useQuery', async () => {
    render(
      <AppProviders>
        <Probe />
      </AppProviders>,
    );
    expect(screen.getByText('pending')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('ready')).toBeInTheDocument());
  });

  it('renders arbitrary children unchanged', () => {
    render(
      <AppProviders>
        <div>Plain child</div>
      </AppProviders>,
    );
    expect(screen.getByText('Plain child')).toBeInTheDocument();
  });
});
