import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Select } from './Select';

const OPTIONS = [
  { value: 'IN', label: 'India' },
  { value: 'ID', label: 'Indonesia' },
  { value: 'PH', label: 'Philippines' },
  { value: 'VN', label: 'Vietnam', disabled: true },
];

const meta: Meta<typeof Select> = {
  title: 'Design System/Select',
  component: Select,
  args: { label: 'Country', options: OPTIONS },
};
export default meta;

type Story = StoryObj<typeof Select>;

export const Interactive: Story = {
  render: (args) => {
    function Wrapper() {
      const [value, setValue] = useState<string | null>(null);
      return <Select {...args} value={value} onChange={setValue} />;
    }
    return <Wrapper />;
  },
};

export const WithSelection: Story = { args: { value: 'ID', onChange: () => {} } };
export const WithError: Story = {
  args: { value: null, onChange: () => {}, error: 'Choose a country' },
};
export const Disabled: Story = { args: { value: null, onChange: () => {}, disabled: true } };
