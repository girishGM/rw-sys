import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectorConfigEditor, type ConnectorConfigEntry } from './ConnectorConfigEditor';

describe('ConnectorConfigEditor', () => {
  it('renders an empty state when there are no entries', () => {
    render(<ConnectorConfigEditor entries={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/no connector configuration set/i)).toBeInTheDocument();
  });

  it('adds a new blank entry row', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ConnectorConfigEditor entries={[]} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /add field/i }));

    expect(onChange).toHaveBeenCalledWith([{ key: '', value: '' }]);
  });

  it('removes an entry row', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const entries: ConnectorConfigEntry[] = [{ key: 'apiKey', value: 'sk_live_1234' }];
    render(<ConnectorConfigEditor entries={entries} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /remove field/i }));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('the value field masks input as a password — never plaintext on screen', () => {
    const entries: ConnectorConfigEntry[] = [{ key: 'apiKey', value: 'sk_live_1234' }];
    render(<ConnectorConfigEditor entries={entries} onChange={vi.fn()} />);

    const valueInput = screen.getByPlaceholderText(/sk_live/i);
    expect(valueInput).toHaveAttribute('type', 'password');
  });

  it('updates a key/value pair', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const entries: ConnectorConfigEntry[] = [{ key: '', value: '' }];
    render(<ConnectorConfigEditor entries={entries} onChange={onChange} />);

    await user.type(screen.getByPlaceholderText('apiKey'), 'a');
    expect(onChange).toHaveBeenCalledWith([{ key: 'a', value: '' }]);
  });
});
