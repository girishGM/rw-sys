import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Drawer } from './Drawer';
import { Button } from './Button';

const meta: Meta<typeof Drawer> = {
  title: 'Design System/Drawer',
  component: Drawer,
};
export default meta;

type Story = StoryObj<typeof Drawer>;

function DrawerHarness(props: Partial<{ side: 'left' | 'right' }>) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <Button onClick={() => setOpen(true)}>Open drawer</Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Campaign detail"
        footer={<Button onClick={() => setOpen(false)}>Close</Button>}
        {...props}
      >
        <p>Full campaign configuration renders here.</p>
      </Drawer>
    </div>
  );
}

export const Right: Story = { render: () => <DrawerHarness side="right" /> };
export const Left: Story = { render: () => <DrawerHarness side="left" /> };
