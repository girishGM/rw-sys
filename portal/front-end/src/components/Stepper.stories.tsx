import type { Meta, StoryObj } from '@storybook/react';
import { Stepper } from './Stepper';

const STEPS = [
  { label: 'Basics', description: 'Name & type' },
  { label: 'Countries', description: 'Assign versions' },
  { label: 'Journey', description: 'Trackers & components' },
  { label: 'Review', description: 'Submit for approval' },
];

const meta: Meta<typeof Stepper> = {
  title: 'Design System/Stepper',
  component: Stepper,
  args: { steps: STEPS },
};
export default meta;

type Story = StoryObj<typeof Stepper>;

export const FirstStep: Story = { args: { currentStep: 0 } };
export const MiddleStep: Story = { args: { currentStep: 2 } };
export const LastStep: Story = { args: { currentStep: 3 } };
