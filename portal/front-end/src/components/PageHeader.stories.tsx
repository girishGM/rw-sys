import type { Meta, StoryObj } from '@storybook/react';
import { PageHeader } from './PageHeader';
import { Breadcrumb } from './Breadcrumb';
import { Button } from './Button';

const meta: Meta<typeof PageHeader> = {
  title: 'Design System/PageHeader',
  component: PageHeader,
};
export default meta;

type Story = StoryObj<typeof PageHeader>;

export const Default: Story = { args: { title: 'Campaigns' } };

export const WithDescriptionBreadcrumbAndActions: Story = {
  args: {
    title: 'Summer Promo',
    description: 'Country: India · Status: Active',
    breadcrumb: (
      <Breadcrumb items={[{ label: 'Campaigns', href: '/campaigns' }, { label: 'Summer Promo' }]} />
    ),
    actions: <Button>Edit campaign</Button>,
  },
};
