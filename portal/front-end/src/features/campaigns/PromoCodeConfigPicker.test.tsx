/**
 * T-127 — the maker's Promo Code Config picker, with `PROMO_CODE_CONFIG_SERVICE` in the state it
 * is actually in today: `planned`, so T-123 answers 501.
 *
 * The mock seam is `lib/apiClient` rather than the `useApiLookupOptionsQuery` hook, so the real
 * `fetchApiLookupOptions` — including its envelope parse and its `toApiError` conversion — runs
 * inside every case. A test that stubbed the hook would prove the component renders a shape this
 * file invented, not the shape the endpoint returns.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders } from 'axios';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock('../../lib/apiClient', () => ({ api: { get: mockGet } }));

import { PromoCodeConfigPicker } from './PromoCodeConfigPicker';

/** The error envelope `ErrorNormalizationFilter` (T-014) actually puts on the wire, wrapped the
 * way axios delivers it — so `toApiError` has something real to parse. */
function serverError(status: number, code: string, message: string): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError(message, String(status), config, null, {
    status,
    statusText: '',
    headers: {},
    config,
    data: { error: { code, message, traceId: 'trace-1' } },
  });
}

function renderPicker(onChange = vi.fn(), value: string | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PromoCodeConfigPicker value={value} onChange={onChange} />
    </QueryClientProvider>,
  );
  return onChange;
}

beforeEach(() => {
  mockGet.mockReset();
});

describe('PromoCodeConfigPicker', () => {
  it('TC-3: a planned provider’s 501 renders as "not available yet", never as an error', async () => {
    mockGet.mockRejectedValue(
      serverError(501, 'FIELD_LOOKUP_PROVIDER_NOT_AVAILABLE', 'Provider not available.'),
    );
    renderPicker();

    expect(await screen.findByText(/not available yet/i)).toBeInTheDocument();
    // Deliberately not an alert: nothing has gone wrong, and the maker can still attach.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /promo code config/i })).toBeDisabled();
  });

  it('calls the provider T-119 names, once, and does not retry a 501', async () => {
    mockGet.mockRejectedValue(
      serverError(501, 'FIELD_LOOKUP_PROVIDER_NOT_AVAILABLE', 'Provider not available.'),
    );
    renderPicker();
    await screen.findByText(/not available yet/i);

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('/field-value-sources/api/PROMO_CODE_CONFIG_SERVICE');
  });

  it('a real failure is a real failure — an upstream 502 shows the server’s own message', async () => {
    mockGet.mockRejectedValue(
      serverError(502, 'FIELD_API_LOOKUP_UPSTREAM_ERROR', 'The lookup provider did not answer.'),
    );
    renderPicker();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The lookup provider did not answer',
    );
    expect(screen.queryByText(/not available yet/i)).not.toBeInTheDocument();
  });

  it('once the service exists, its options are selectable and reported back as strings', async () => {
    mockGet.mockResolvedValue({
      data: {
        data: [
          { value: 'RAYA_2026', label: 'Raya 2026 codes' },
          { value: 77, label: 'Numeric-keyed config' },
        ],
      },
    });
    const user = userEvent.setup();
    const onChange = renderPicker();

    await user.click(await screen.findByRole('combobox', { name: /promo code config/i }));
    await user.click(screen.getByRole('option', { name: 'Raya 2026 codes' }));
    expect(onChange).toHaveBeenCalledWith('RAYA_2026');

    // `value` is `string | number` on the wire (T-123); the stored config is always a string.
    await user.click(screen.getByRole('combobox', { name: /promo code config/i }));
    await user.click(screen.getByRole('option', { name: 'Numeric-keyed config' }));
    expect(onChange).toHaveBeenCalledWith('77');
  });

  it('rejects a response that is not the documented { value, label } shape', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ code: 'RAYA_2026' }] } });
    renderPicker();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
