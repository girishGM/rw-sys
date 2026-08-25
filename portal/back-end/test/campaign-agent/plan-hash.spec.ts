/**
 * T-048 — the plan hash (`plan-hash.service.ts`), 10-AI-CAMPAIGN-AGENT.md §3.2.
 *
 * TC-14 and TC-15 both come down to one property: **the hash changes when, and only when, the plan
 * changes**. Everything here exercises one half of that.
 */
import { PlanHashService } from '@/modules/campaign-agent/plan-hash.service';

const service = new PlanHashService();

const plan = {
  campaign: { name: 'Weekend cashback', budgetAmount: '50000.00' },
  merchants: [{ merchantId: 7, name: 'Acme' }],
  components: [{ name: 'First purchase', rules: [{ ruleId: 3, values: { minSpend: 50 } }] }],
};

describe('canonicalJson', () => {
  it('sorts object keys recursively, so key order cannot change the hash', () => {
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    expect(service.canonicalJson(a)).toBe(service.canonicalJson(b));
  });

  it('preserves array order, because array order is semantically meaningful', () => {
    // Component 1 then component 2 is a different journey from the reverse.
    expect(service.canonicalJson([1, 2])).not.toBe(service.canonicalJson([2, 1]));
  });

  it('handles nulls and nested arrays of objects', () => {
    expect(service.canonicalJson({ a: null, b: [{ y: 1, x: 2 }] })).toBe(
      '{"a":null,"b":[{"x":2,"y":1}]}',
    );
  });
});

describe('hash', () => {
  it('is a lower-case sha256 hex string', () => {
    expect(service.hash(plan)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across two calls with the same plan', () => {
    expect(service.hash(plan)).toBe(service.hash(structuredClone(plan)));
  });

  it('changes when any part of the plan changes — TC-15', () => {
    const mutated = structuredClone(plan);
    mutated.campaign.budgetAmount = '500000.00';
    expect(service.hash(mutated)).not.toBe(service.hash(plan));
  });

  it('changes when a merchant is added', () => {
    const mutated = structuredClone(plan);
    mutated.merchants.push({ merchantId: 9, name: 'Other' });
    expect(service.hash(mutated)).not.toBe(service.hash(plan));
  });

  it('changes when a rule value changes — the subtlest tamper', () => {
    const mutated = structuredClone(plan);
    mutated.components[0].rules[0].values.minSpend = 1;
    expect(service.hash(mutated)).not.toBe(service.hash(plan));
  });
});

describe('matches — the confirm gate', () => {
  it('accepts the hash of the plan it was given', () => {
    expect(service.matches(plan, service.hash(plan))).toBe(true);
  });

  it('rejects a hash of a different plan — TC-14', () => {
    expect(service.matches(plan, service.hash({ ...plan, merchants: [] }))).toBe(false);
  });

  it('rejects a hash of the wrong length rather than throwing', () => {
    expect(service.matches(plan, 'deadbeef')).toBe(false);
    expect(service.matches(plan, '')).toBe(false);
  });

  it('rejects a hash that differs in one character', () => {
    const correct = service.hash(plan);
    const tampered = `${correct.slice(0, 63)}${correct.endsWith('a') ? 'b' : 'a'}`;
    expect(service.matches(plan, tampered)).toBe(false);
  });
});
