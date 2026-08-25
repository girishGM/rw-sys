import type { Meta, StoryObj } from '@storybook/react';
import { Badge } from './Badge';

const meta: Meta<typeof Badge> = {
  title: 'Design System/Badge',
  component: Badge,
  args: { children: 'New' },
};
export default meta;

type Story = StoryObj<typeof Badge>;

export const Slate: Story = { args: { tone: 'slate' } };
export const Primary: Story = { args: { tone: 'primary' } };
export const Success: Story = { args: { tone: 'success' } };
export const Warning: Story = { args: { tone: 'warning' } };
export const Danger: Story = { args: { tone: 'danger' } };
export const Sky: Story = { args: { tone: 'sky' } };
