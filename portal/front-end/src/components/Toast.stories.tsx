import type { Meta, StoryObj } from '@storybook/react';
import { Toaster } from './Toast';
import { toast } from './toastActions';
import { Button } from './Button';

const meta: Meta<typeof Toaster> = {
  title: 'Design System/Toast',
  component: Toaster,
};
export default meta;

type Story = StoryObj<typeof Toaster>;

export const Success: Story = {
  render: () => (
    <div>
      <Toaster />
      <Button onClick={() => toast.success('Campaign published')}>Trigger success toast</Button>
    </div>
  ),
};

export const Error: Story = {
  render: () => (
    <div>
      <Toaster />
      <Button variant="danger" onClick={() => toast.error('Failed to save campaign')}>
        Trigger error toast
      </Button>
    </div>
  ),
};

export const WithDescription: Story = {
  render: () => (
    <div>
      <Toaster />
      <Button
        onClick={() =>
          toast('Version blast queued', { description: 'India · Indonesia · Philippines' })
        }
      >
        Trigger toast with description
      </Button>
    </div>
  ),
};
