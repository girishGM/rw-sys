import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Checkbox } from './Checkbox';

const meta: Meta<typeof Checkbox> = {
  title: 'Design System/Checkbox',
  component: Checkbox,
  args: { label: 'Send email receipt' },
};
export default meta;

type Story = StoryObj<typeof Checkbox>;

export const Unchecked: Story = {
  render: (args) => {
    function Wrapper() {
      const [checked, setChecked] = useState(false);
      return (
        <Checkbox {...args} checked={checked} onChange={(e) => setChecked(e.target.checked)} />
      );
    }
    return <Wrapper />;
  },
};

export const Checked: Story = { args: { checked: true, onChange: () => {} } };
export const Indeterminate: Story = {
  args: { checked: false, indeterminate: true, onChange: () => {} },
};
export const WithError: Story = {
  args: { checked: false, onChange: () => {}, error: 'You must accept the terms' },
};
export const Disabled: Story = { args: { checked: false, onChange: () => {}, disabled: true } };
