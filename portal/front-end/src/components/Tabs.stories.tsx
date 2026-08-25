import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Tabs } from './Tabs';

const ITEMS = [
  { value: 'details', label: 'Details', panel: <p>Campaign details go here.</p> },
  { value: 'history', label: 'History', panel: <p>Version history goes here.</p> },
  { value: 'audit', label: 'Audit', panel: <p>Audit log goes here.</p> },
  { value: 'archived', label: 'Archived', panel: <p>Not reachable.</p>, disabled: true },
];

const meta: Meta<typeof Tabs> = {
  title: 'Design System/Tabs',
  component: Tabs,
  args: { items: ITEMS },
};
export default meta;

type Story = StoryObj<typeof Tabs>;

export const Interactive: Story = {
  render: (args) => {
    function Wrapper() {
      const [value, setValue] = useState('details');
      return <Tabs {...args} value={value} onChange={setValue} />;
    }
    return <Wrapper />;
  },
};
