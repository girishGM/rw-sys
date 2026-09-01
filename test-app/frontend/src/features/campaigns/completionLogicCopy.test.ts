/**
 * T-008 — `completionLogicCopy` names the real `completion_logic` correctly (TC-3), including the
 * `n_of` case a tracker with only `all`-logic demo data doesn't otherwise exercise (this task's
 * implementation notes: "a tracker with `n_of` logic ... should render sensibly").
 */
import { describe, expect, it } from 'vitest';
import { completionLogicCopy } from './completionLogicCopy';

describe('completionLogicCopy', () => {
  it('reads "Requires ALL components" for `all` logic', () => {
    expect(completionLogicCopy('all', null, 5)).toBe('Requires ALL components');
  });

  it('reads "Requires ANY ONE component" for `any` logic', () => {
    expect(completionLogicCopy('any', null, 5)).toBe('Requires ANY ONE component');
  });

  it('reads "Requires N of M components" for `n_of` logic, using the real threshold', () => {
    expect(completionLogicCopy('n_of', 2, 4)).toBe('Requires 2 of 4 components');
  });

  it('falls back to the component count as the threshold if `n_of` has no explicit one', () => {
    expect(completionLogicCopy('n_of', null, 3)).toBe('Requires 3 of 3 components');
  });
});
