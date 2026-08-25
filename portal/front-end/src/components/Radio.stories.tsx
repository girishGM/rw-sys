import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { RadioGroup } from './Radio';

const meta: Meta<typeof RadioGroup> = {
  title: 'Design System/RadioGroup',
  component: RadioGroup,
  args: {
    name: 'frequency',
    label: 'Blast frequency',
    options: [
      { value: 'daily', label: 'Daily' },
      { value: 'weekly', label: 'Weekly' },
      { value: 'monthly', label: 'Monthly', disabled: true },
    ],
  },
};
export default meta;

type Story = StoryObj<typeof RadioGroup>;

export const Vertical: Story = {
  render: (args) => {
    function Wrapper() {
      const [value, setValue] = useState('daily');
      return <RadioGroup {...args} value={value} onChange={setValue} />;
    }
    return <Wrapper />;
  },
};

export const Horizontal: Story = {
  args: { orientation: 'horizontal', value: 'daily', onChange: () => {} },
};

export const WithError: Story = {
  args: { value: null, onChange: () => {}, error: 'Select a frequency' },
};
