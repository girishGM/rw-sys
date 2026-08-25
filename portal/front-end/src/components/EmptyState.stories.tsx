import type { Meta, StoryObj } from '@storybook/react';
import { EmptyState } from './EmptyState';
import { Button } from './Button';

const meta: Meta<typeof EmptyState> = {
  title: 'Design System/EmptyState',
  component: EmptyState,
};
export default meta;

type Story = StoryObj<typeof EmptyState>;

export const Default: Story = { args: { message: 'No campaigns yet' } };

export const WithDescriptionAndAction: Story = {
  args: {
    message: 'No campaigns yet',
    description: 'Create your first campaign to get started.',
    action: <Button>Create campaign</Button>,
  },
};
