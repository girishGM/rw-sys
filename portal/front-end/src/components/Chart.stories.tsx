import type { Meta, StoryObj } from '@storybook/react';
import { Chart } from './Chart';

const meta: Meta<typeof Chart> = {
  title: 'Design System/Chart',
  component: Chart,
  args: {
    title: 'Redemptions by week',
    data: [
      { label: 'Week 1', value: 12 },
      { label: 'Week 2', value: 28 },
      { label: 'Week 3', value: 19 },
      { label: 'Week 4', value: 34 },
    ],
  },
};
export default meta;

type Story = StoryObj<typeof Chart>;

export const Default: Story = {};
export const SingleBar: Story = { args: { data: [{ label: 'Total', value: 100 }] } };
