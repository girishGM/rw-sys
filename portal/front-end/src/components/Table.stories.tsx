import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Table, type TableColumn } from './Table';
import { StatusPill, type CampaignStatus } from './StatusPill';

interface CampaignRow {
  id: string;
  name: string;
  status: CampaignStatus;
}

const ROWS: CampaignRow[] = [
  { id: '1', name: 'Summer Promo', status: 'active' },
  { id: '2', name: 'Diwali Cashback', status: 'pending_approval' },
  { id: '3', name: 'New Year Bonanza', status: 'draft' },
];

const columns: TableColumn<CampaignRow>[] = [
  { key: 'name', header: 'Campaign', render: (row) => row.name, sortable: true },
  { key: 'status', header: 'Status', render: (row) => <StatusPill status={row.status} /> },
];

const meta: Meta<typeof Table<CampaignRow>> = {
  title: 'Design System/Table',
  component: Table<CampaignRow>,
  args: { caption: 'Campaigns', columns, getRowId: (row: CampaignRow) => row.id },
};
export default meta;

type Story = StoryObj<typeof Table<CampaignRow>>;

export const Populated: Story = { args: { data: ROWS } };
export const Loading: Story = { args: { data: [], isLoading: true } };
export const Empty: Story = { args: { data: [], emptyMessage: 'No campaigns match your filters' } };
export const ErrorState: Story = {
  args: { data: [], error: 'Failed to load campaigns. Try again.' },
};

export const Sortable: Story = {
  render: (args) => {
    function Wrapper() {
      const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
      return (
        <Table
          {...args}
          sort={{ key: 'name', direction }}
          onSortChange={() => setDirection((d) => (d === 'asc' ? 'desc' : 'asc'))}
        />
      );
    }
    return <Wrapper />;
  },
  args: { data: ROWS },
};
