import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ConfirmDialog } from './ConfirmDialog';
import { Button } from './Button';

const meta: Meta<typeof ConfirmDialog> = {
  title: 'Design System/ConfirmDialog',
  component: ConfirmDialog,
};
export default meta;

type Story = StoryObj<typeof ConfirmDialog>;

/** T-021 TC-11 — destructive confirm; focus still defaults to Cancel, not Delete. */
export const Destructive: Story = {
  render: () => {
    function Wrapper() {
      const [open, setOpen] = useState(true);
      return (
        <div>
          <Button variant="danger" onClick={() => setOpen(true)}>
            Delete campaign
          </Button>
          <ConfirmDialog
            open={open}
            onCancel={() => setOpen(false)}
            onConfirm={() => setOpen(false)}
            title="Delete campaign?"
            description='"Summer Promo" will be removed from every assigned country. This cannot be undone.'
            variant="destructive"
            confirmLabel="Delete"
          />
        </div>
      );
    }
    return <Wrapper />;
  },
};

export const Default: Story = {
  render: () => {
    function Wrapper() {
      const [open, setOpen] = useState(true);
      return (
        <div>
          <Button onClick={() => setOpen(true)}>Publish version</Button>
          <ConfirmDialog
            open={open}
            onCancel={() => setOpen(false)}
            onConfirm={() => setOpen(false)}
            title="Publish this version?"
            confirmLabel="Publish"
          />
        </div>
      );
    }
    return <Wrapper />;
  },
};
