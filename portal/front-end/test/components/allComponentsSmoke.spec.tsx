import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import {
  Badge,
  Breadcrumb,
  Button,
  Card,
  CardBody,
  Chart,
  Checkbox,
  ConfirmDialog,
  DatePicker,
  DescriptionList,
  DescriptionItem,
  Drawer,
  EmptyState,
  Input,
  KpiTile,
  Modal,
  MultiSelect,
  PageHeader,
  RadioGroup,
  Select,
  Skeleton,
  Stepper,
  StatusPill,
  Table,
  Tabs,
  toast,
  Toaster,
  Toggle,
} from '../../src/components';

/**
 * T-021 TC-1 — "every component renders in its default state: no console errors or
 * warnings". One file, one instance of every component in the §7 inventory, asserting
 * `console.error`/`console.warn` were never called during render.
 */
describe('design system — every component renders cleanly (TC-1)', () => {
  function expectNoConsoleNoise(render: () => void) {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  }

  it('Button', () => expectNoConsoleNoise(() => render(<Button>Save</Button>)));
  it('Badge', () => expectNoConsoleNoise(() => render(<Badge>New</Badge>)));
  it('StatusPill', () => expectNoConsoleNoise(() => render(<StatusPill status="active" />)));
  it('Card', () =>
    expectNoConsoleNoise(() =>
      render(
        <Card>
          <CardBody>Body</CardBody>
        </Card>,
      ),
    ));
  it('Skeleton', () => expectNoConsoleNoise(() => render(<Skeleton className="h-4 w-24" />)));
  it('EmptyState', () => expectNoConsoleNoise(() => render(<EmptyState message="Nothing here" />)));
  it('PageHeader', () => expectNoConsoleNoise(() => render(<PageHeader title="Campaigns" />)));
  it('Breadcrumb', () =>
    expectNoConsoleNoise(() =>
      render(<Breadcrumb items={[{ label: 'Home', href: '/' }, { label: 'Campaigns' }]} />),
    ));
  it('KpiTile', () => expectNoConsoleNoise(() => render(<KpiTile label="Active" value={1} />)));
  it('Chart', () =>
    expectNoConsoleNoise(() =>
      render(<Chart title="Redemptions" data={[{ label: 'W1', value: 1 }]} />),
    ));
  it('Input', () => expectNoConsoleNoise(() => render(<Input label="Name" />)));
  it('Checkbox', () =>
    expectNoConsoleNoise(() =>
      render(<Checkbox label="Agree" checked={false} onChange={() => {}} />),
    ));
  it('RadioGroup', () =>
    expectNoConsoleNoise(() =>
      render(
        <RadioGroup
          name="freq"
          label="Frequency"
          options={[{ value: 'a', label: 'A' }]}
          value="a"
          onChange={() => {}}
        />,
      ),
    ));
  it('Toggle', () =>
    expectNoConsoleNoise(() =>
      render(<Toggle label="Enabled" checked={false} onChange={() => {}} />),
    ));
  it('Select', () =>
    expectNoConsoleNoise(() =>
      render(
        <Select
          label="Country"
          options={[{ value: 'IN', label: 'India' }]}
          value={null}
          onChange={() => {}}
        />,
      ),
    ));
  it('MultiSelect', () =>
    expectNoConsoleNoise(() =>
      render(
        <MultiSelect
          label="Countries"
          options={[{ value: 'IN', label: 'India' }]}
          value={[]}
          onChange={() => {}}
        />,
      ),
    ));
  it('DatePicker', () =>
    expectNoConsoleNoise(() =>
      render(<DatePicker label="Start date" value={null} onChange={() => {}} />),
    ));
  it('DescriptionList', () =>
    expectNoConsoleNoise(() =>
      render(
        <DescriptionList>
          <DescriptionItem term="Status" detail="Active" />
        </DescriptionList>,
      ),
    ));
  it('Table', () =>
    expectNoConsoleNoise(() =>
      render(
        <Table
          caption="Campaigns"
          columns={[{ key: 'name', header: 'Name', render: (row: { name: string }) => row.name }]}
          data={[{ name: 'Summer promo' }]}
          getRowId={(row: { name: string }) => row.name}
        />,
      ),
    ));
  it('Tabs', () =>
    expectNoConsoleNoise(() =>
      render(
        <Tabs
          value="a"
          onChange={() => {}}
          items={[{ value: 'a', label: 'A', panel: <div>A panel</div> }]}
        />,
      ),
    ));
  it('Modal', () =>
    expectNoConsoleNoise(() =>
      render(
        <Modal open onClose={() => {}} title="Title">
          Body
        </Modal>,
      ),
    ));
  it('Drawer', () =>
    expectNoConsoleNoise(() =>
      render(
        <Drawer open onClose={() => {}} title="Title">
          Body
        </Drawer>,
      ),
    ));
  it('ConfirmDialog', () =>
    expectNoConsoleNoise(() =>
      render(<ConfirmDialog open onConfirm={() => {}} onCancel={() => {}} title="Confirm" />),
    ));
  it('Stepper', () =>
    expectNoConsoleNoise(() => render(<Stepper currentStep={0} steps={[{ label: 'Step 1' }]} />)));
  it('Toast (Toaster + enqueue)', () =>
    expectNoConsoleNoise(() => {
      render(<Toaster />);
      toast('Hello');
    }));
});
