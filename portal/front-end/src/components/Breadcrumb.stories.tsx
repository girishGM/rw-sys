import type { Meta, StoryObj } from '@storybook/react';
import { Breadcrumb } from './Breadcrumb';

const meta: Meta<typeof Breadcrumb> = {
  title: 'Design System/Breadcrumb',
  component: Breadcrumb,
};
export default meta;

type Story = StoryObj<typeof Breadcrumb>;

export const TwoLevels: Story = {
  args: { items: [{ label: 'Campaigns', href: '/campaigns' }, { label: 'Summer Promo' }] },
};

export const ThreeLevels: Story = {
  args: {
    items: [
      { label: 'Countries', href: '/countries' },
      { label: 'India', href: '/countries/in' },
      { label: 'Rules' },
    ],
  },
};
