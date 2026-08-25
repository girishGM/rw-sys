import type { Meta, StoryObj } from '@storybook/react';
import { Input } from './Input';

const meta: Meta<typeof Input> = {
  title: 'Design System/Input',
  component: Input,
  args: { label: 'Campaign name', placeholder: 'Summer Promo 2026' },
};
export default meta;

type Story = StoryObj<typeof Input>;

export const Default: Story = {};
export const WithHint: Story = { args: { hint: 'Visible to Country Admins only.' } };
export const WithError: Story = { args: { error: 'Campaign name is required.' } };
export const Disabled: Story = { args: { disabled: true, defaultValue: 'Locked value' } };
export const HiddenLabel: Story = { args: { hideLabel: true, placeholder: 'Search campaigns…' } };
