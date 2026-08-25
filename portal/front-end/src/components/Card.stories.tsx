import type { Meta, StoryObj } from '@storybook/react';
import { Card, CardBody, CardFooter, CardHeader } from './Card';
import { Button } from './Button';

const meta: Meta<typeof Card> = {
  title: 'Design System/Card',
  component: Card,
};
export default meta;

type Story = StoryObj<typeof Card>;

export const Default: Story = {
  render: () => (
    <Card style={{ maxWidth: 360 }}>
      <CardHeader>Campaign summary</CardHeader>
      <CardBody>Active from 1 Sep to 30 Sep, 3 countries assigned.</CardBody>
      <CardFooter>
        <Button variant="secondary">View</Button>
        <Button>Edit</Button>
      </CardFooter>
    </Card>
  ),
};

export const BodyOnly: Story = {
  render: () => (
    <Card style={{ maxWidth: 360 }}>
      <CardBody>No header or footer — just content.</CardBody>
    </Card>
  ),
};
