import type { Meta, StoryObj } from '@storybook/react';
import { DescriptionList, DescriptionItem } from './DescriptionList';
import { Card, CardBody, CardHeader } from './Card';

const meta: Meta<typeof DescriptionList> = {
  title: 'Design System/DescriptionList',
  component: DescriptionList,
};
export default meta;

type Story = StoryObj<typeof DescriptionList>;

/** T-063 TC-3/TC-5: rendered on a white `Card`, exactly like a real detail screen — this is
 * what `npm run test:a11y` scans for contrast. */
export const OnCard: Story = {
  render: () => (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-slate-900">Details</h2>
      </CardHeader>
      <CardBody>
        <DescriptionList>
          <DescriptionItem term="Schema prefix" detail="tn_00042" />
          <DescriptionItem term="Contact email" detail="admin@example.com" />
          <DescriptionItem term="Contact phone" detail="—" />
        </DescriptionList>
      </CardBody>
    </Card>
  ),
};

/** Standalone usage (no `Card` wrapper) — a single-column layout via `className`. */
export const Standalone: Story = {
  render: () => (
    <DescriptionList className="grid-cols-1">
      <DescriptionItem term="Status" detail="Active" />
      <DescriptionItem term="Priority" detail="High" />
    </DescriptionList>
  ),
};
