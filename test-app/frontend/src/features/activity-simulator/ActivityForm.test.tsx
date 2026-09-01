/**
 * T-010 — `ActivityForm`'s own contract: submit stays disabled until a real activity type is
 * picked (never fires with an empty value), passes real merchant/amount through only when the
 * user actually entered them, and stays disabled while a submission is already in flight (TC-8).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ActivityForm } from './ActivityForm';

function selectActivityType(name: RegExp | string) {
  const trigger = screen.getByRole('combobox', { name: 'Activity type' });
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1, pointerType: 'mouse' });
  fireEvent.click(trigger);

  const option = screen.getByRole('option', { name });
  fireEvent.pointerUp(option, { button: 0, pointerId: 1, pointerType: 'mouse' });
  fireEvent.click(option);
}

describe('ActivityForm', () => {
  it('disables submit until a real activity type is selected', () => {
    const onSubmit = vi.fn();
    render(
      <ActivityForm
        activityTypeOptions={['Grocery Purchase', 'Weekend Transaction']}
        optionsLoading={false}
        isSubmitting={false}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByRole('button', { name: /submit activity/i })).toBeDisabled();
  });

  it('submits the selected activity type plus optional merchant/amount', () => {
    const onSubmit = vi.fn();
    render(
      <ActivityForm
        activityTypeOptions={['Grocery Purchase', 'Weekend Transaction']}
        optionsLoading={false}
        isSubmitting={false}
        onSubmit={onSubmit}
      />,
    );

    selectActivityType('Grocery Purchase');
    fireEvent.change(screen.getByLabelText(/merchant/i), { target: { value: 'Fresh Mart' } });
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '42.50' } });

    const submit = screen.getByRole('button', { name: /submit activity/i });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    expect(onSubmit).toHaveBeenCalledWith({
      activityType: 'Grocery Purchase',
      merchant: 'Fresh Mart',
      amount: 42.5,
    });
  });

  it('omits merchant/amount entirely when left blank', () => {
    const onSubmit = vi.fn();
    render(
      <ActivityForm
        activityTypeOptions={['Grocery Purchase']}
        optionsLoading={false}
        isSubmitting={false}
        onSubmit={onSubmit}
      />,
    );

    selectActivityType('Grocery Purchase');
    fireEvent.click(screen.getByRole('button', { name: /submit activity/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      activityType: 'Grocery Purchase',
      merchant: undefined,
      amount: undefined,
    });
  });

  it('TC-8: submit stays disabled while a submission is already in flight, even with a real activity type selected', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <ActivityForm
        activityTypeOptions={['Grocery Purchase']}
        optionsLoading={false}
        isSubmitting={false}
        onSubmit={onSubmit}
      />,
    );
    selectActivityType('Grocery Purchase');

    rerender(
      <ActivityForm
        activityTypeOptions={['Grocery Purchase']}
        optionsLoading={false}
        isSubmitting={true}
        onSubmit={onSubmit}
      />,
    );

    const submit = screen.getByRole('button', { name: /submitting/i });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
