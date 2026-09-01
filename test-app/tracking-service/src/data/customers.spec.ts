import { CUSTOMERS, getCustomerById, isValidCustomerId } from './customers';

describe('customers', () => {
  it('TC-6: has exactly 3 demo customers with stable ids', () => {
    expect(CUSTOMERS).toHaveLength(3);
    expect(CUSTOMERS.map((c) => c.id)).toEqual(['priya-shah', 'marcus-tan', 'aisha-rahman']);
  });

  it('includes Priya Shah, per ARCHITECTURE.md / T-003 scope', () => {
    expect(CUSTOMERS.some((c) => c.displayName === 'Priya Shah')).toBe(true);
  });

  it('every customer has a non-empty avatarInitials', () => {
    for (const customer of CUSTOMERS) {
      expect(customer.avatarInitials.length).toBeGreaterThan(0);
    }
  });

  it('getCustomerById / isValidCustomerId round-trip real ids and reject unknown ones', () => {
    expect(getCustomerById('priya-shah')?.displayName).toBe('Priya Shah');
    expect(getCustomerById('no-such-customer')).toBeUndefined();
    expect(isValidCustomerId('priya-shah')).toBe(true);
    expect(isValidCustomerId('no-such-customer')).toBe(false);
  });
});
