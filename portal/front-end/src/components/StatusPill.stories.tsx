import type { Meta, StoryObj } from '@storybook/react';
import { StatusPill } from './StatusPill';

const meta: Meta<typeof StatusPill> = {
  title: 'Design System/StatusPill',
  component: StatusPill,
};
export default meta;

type Story = StoryObj<typeof StatusPill>;

export const Draft: Story = { args: { status: 'draft' } };
export const PendingApproval: Story = { args: { status: 'pending_approval' } };
export const Active: Story = { args: { status: 'active' } };
export const Paused: Story = { args: { status: 'paused' } };
export const Rejected: Story = { args: { status: 'rejected' } };
export const Completed: Story = { args: { status: 'completed' } };
export const Archived: Story = { args: { status: 'archived' } };

/** All seven statuses side by side — the reference sheet feature agents actually use. */
export const AllStatuses: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <StatusPill status="draft" />
      <StatusPill status="pending_approval" />
      <StatusPill status="active" />
      <StatusPill status="paused" />
      <StatusPill status="rejected" />
      <StatusPill status="completed" />
      <StatusPill status="archived" />
    </div>
  ),
};
