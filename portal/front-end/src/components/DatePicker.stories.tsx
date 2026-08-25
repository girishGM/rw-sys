import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { DatePicker } from './DatePicker';

const meta: Meta<typeof DatePicker> = {
  title: 'Design System/DatePicker',
  component: DatePicker,
  args: { label: 'Start date' },
};
export default meta;

type Story = StoryObj<typeof DatePicker>;

export const Interactive: Story = {
  render: (args) => {
    function Wrapper() {
      const [value, setValue] = useState<Date | null>(null);
      return <DatePicker {...args} value={value} onChange={setValue} />;
    }
    return <Wrapper />;
  },
};

export const WithValue: Story = { args: { value: new Date(2026, 8, 1), onChange: () => {} } };
export const WithError: Story = {
  args: { value: null, onChange: () => {}, error: 'Enter a valid date (YYYY-MM-DD)' },
};
export const Disabled: Story = { args: { value: null, onChange: () => {}, disabled: true } };
