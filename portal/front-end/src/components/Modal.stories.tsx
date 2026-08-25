import { useState, type ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Modal } from './Modal';
import { Button } from './Button';

const meta: Meta<typeof Modal> = {
  title: 'Design System/Modal',
  component: Modal,
};
export default meta;

type Story = StoryObj<typeof Modal>;

function ModalHarness(props: Partial<ComponentProps<typeof Modal>>) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <Button onClick={() => setOpen(true)}>Open modal</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Delete campaign"
        description="This cannot be undone."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => setOpen(false)}>
              Delete
            </Button>
          </>
        }
        {...props}
      >
        <p>Deleting "Summer Promo" removes it from every country it is assigned to.</p>
      </Modal>
    </div>
  );
}

export const Default: Story = { render: () => <ModalHarness /> };
export const Small: Story = { render: () => <ModalHarness size="sm" /> };
export const Large: Story = { render: () => <ModalHarness size="lg" /> };
