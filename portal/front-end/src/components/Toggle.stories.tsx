import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Toggle } from './Toggle';

const meta: Meta<typeof Toggle> = {
  title: 'Design System/Toggle',
  component: Toggle,
  args: { label: 'Enable notifications' },
};
export default meta;

type Story = StoryObj<typeof Toggle>;

export const Interactive: Story = {
  render: (args) => {
    function Wrapper() {
      const [checked, setChecked] = useState(false);
      return <Toggle {...args} checked={checked} onChange={setChecked} />;
    }
    return <Wrapper />;
  },
};

export const On: Story = { args: { checked: true, onChange: () => {} } };
export const Off: Story = { args: { checked: false, onChange: () => {} } };
export const Disabled: Story = { args: { checked: false, onChange: () => {}, disabled: true } };
