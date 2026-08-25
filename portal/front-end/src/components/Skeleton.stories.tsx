import type { Meta, StoryObj } from '@storybook/react';
import { Skeleton } from './Skeleton';

const meta: Meta<typeof Skeleton> = {
  title: 'Design System/Skeleton',
  component: Skeleton,
};
export default meta;

type Story = StoryObj<typeof Skeleton>;

export const Line: Story = { args: { className: 'h-4 w-48' } };
export const Block: Story = { args: { className: 'h-24 w-full' } };
export const Circle: Story = { args: { className: 'size-10 rounded-full' } };
