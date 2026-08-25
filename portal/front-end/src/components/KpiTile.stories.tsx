import type { Meta, StoryObj } from '@storybook/react';
import { Target } from 'lucide-react';
import { KpiTile } from './KpiTile';

const meta: Meta<typeof KpiTile> = {
  title: 'Design System/KpiTile',
  component: KpiTile,
  args: { label: 'Active campaigns', value: 42 },
};
export default meta;

type Story = StoryObj<typeof KpiTile>;

export const Default: Story = {};
export const WithIcon: Story = { args: { icon: Target } };
export const WithTrendUp: Story = {
  args: { trend: { direction: 'up', value: '+4%', label: 'vs last month' } },
};
export const WithTrendDown: Story = {
  args: { trend: { direction: 'down', value: '-2%', label: 'vs last month' } },
};
export const Loading: Story = { args: { isLoading: true } };
