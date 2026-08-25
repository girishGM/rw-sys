import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Table, type TableColumn } from '../../src/components/Table';

interface Row {
  id: string;
  name: string;
}

const columns: TableColumn<Row>[] = [
  { key: 'name', header: 'Name', render: (row) => row.name, sortable: true },
];

describe('Table', () => {
  it('TC-5: loading state renders skeleton rows and no data rows', () => {
    render(
      <Table caption="Campaigns" columns={columns} data={[]} getRowId={(r) => r.id} isLoading />,
    );
    expect(screen.getByRole('status', { name: 'Loading table data' })).toBeInTheDocument();
    // Exactly one real cell (the colSpan wrapper) — skeleton "rows" are plain divs, not
    // real table rows, so no data has actually rendered yet.
    expect(screen.getAllByRole('cell')).toHaveLength(1);
  });

  it('TC-6: empty data renders EmptyState with the supplied message', () => {
    render(
      <Table
        caption="Campaigns"
        columns={columns}
        data={[]}
        getRowId={(r) => r.id}
        emptyMessage="No campaigns match your filters"
      />,
    );
    expect(screen.getByText('No campaigns match your filters')).toBeInTheDocument();
  });

  it('error state takes precedence and renders an alert', () => {
    render(
      <Table
        caption="Campaigns"
        columns={columns}
        data={[]}
        getRowId={(r) => r.id}
        error="Failed to load campaigns"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load campaigns');
  });

  it('renders populated rows', () => {
    render(
      <Table
        caption="Campaigns"
        columns={columns}
        data={[{ id: '1', name: 'Summer promo' }]}
        getRowId={(r) => r.id}
      />,
    );
    expect(screen.getByText('Summer promo')).toBeInTheDocument();
  });

  it('TC-7: clicking a sortable header updates aria-sort and fires the callback', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    render(
      <Table
        caption="Campaigns"
        columns={columns}
        data={[{ id: '1', name: 'Summer promo' }]}
        getRowId={(r) => r.id}
        sort={{ key: 'name', direction: 'asc' }}
        onSortChange={onSortChange}
      />,
    );
    const header = screen.getByRole('columnheader', { name: /Name/ });
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    await user.click(screen.getByRole('button', { name: /Name/ }));
    expect(onSortChange).toHaveBeenCalledWith('name');
  });

  it('a non-sortable column never renders a sort button or aria-sort', () => {
    render(
      <Table
        caption="Campaigns"
        columns={[{ key: 'name', header: 'Name', render: (row: Row) => row.name }]}
        data={[{ id: '1', name: 'Summer promo' }]}
        getRowId={(r) => r.id}
      />,
    );
    const header = screen.getByRole('columnheader', { name: 'Name' });
    expect(header).not.toHaveAttribute('aria-sort');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
