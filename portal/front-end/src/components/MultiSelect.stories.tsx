import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { MultiSelect } from './MultiSelect';

const OPTIONS = [
  { value: 'IN', label: 'India' },
  { value: 'ID', label: 'Indonesia' },
  { value: 'PH', label: 'Philippines' },
  { value: 'VN', label: 'Vietnam' },
];

const MANY_OPTIONS = Array.from({ length: 500 }, (_, i) => ({
  value: `country-${i}`,
  label: `Country ${i}`,
}));

const meta: Meta<typeof MultiSelect> = {
  title: 'Design System/MultiSelect',
  component: MultiSelect,
  args: { label: 'Countries', options: OPTIONS },
};
export default meta;

type Story = StoryObj<typeof MultiSelect>;

export const Interactive: Story = {
  render: (args) => {
    function Wrapper() {
      const [value, setValue] = useState<string[]>([]);
      return <MultiSelect {...args} value={value} onChange={setValue} />;
    }
    return <Wrapper />;
  },
};

export const WithSelection: Story = { args: { value: ['IN', 'PH'], onChange: () => {} } };
export const WithError: Story = {
  args: { value: [], onChange: () => {}, error: 'Pick at least one country' },
};

/** T-021 TC-13 — 500 options; the popup only ever mounts a small windowed slice. */
export const FiveHundredOptions: Story = {
  args: { options: MANY_OPTIONS },
  render: (args) => {
    function Wrapper() {
      const [value, setValue] = useState<string[]>([]);
      return <MultiSelect {...args} value={value} onChange={setValue} />;
    }
    return <Wrapper />;
  },
};
