/**
 * T-034 — the `class-validator` constraint classes directly, so `defaultMessage()` (server-log
 * only) and the cross-field branch of `WarnAboveNotExceedingCeilingConstraint` are exercised
 * without needing an HTTP round trip. Same shape `country-validators.decorators.spec.ts`
 * establishes.
 */
import 'reflect-metadata';
import type { ValidationArguments } from 'class-validator';
import {
  IsDecimalStringConstraint,
  IsPositiveDecimalStringConstraint,
  IsTenantSchemaPrefixConstraint,
  WarnAboveNotExceedingCeilingConstraint,
} from '@/modules/tenants/dto/tenant-validators.decorators';

describe('IsTenantSchemaPrefixConstraint', () => {
  const constraint = new IsTenantSchemaPrefixConstraint();

  it('delegates to isTenantSchemaPrefix', () => {
    expect(constraint.validate('abc123')).toBe(true);
    expect(constraint.validate('1abc')).toBe(false);
  });

  it('carries a server-side message', () => {
    expect(constraint.defaultMessage()).toContain('lowercase letter');
  });
});

describe('IsPositiveDecimalStringConstraint', () => {
  const constraint = new IsPositiveDecimalStringConstraint();

  it('delegates to isPositiveDecimalString', () => {
    expect(constraint.validate('5000000')).toBe(true);
    expect(constraint.validate('0')).toBe(false);
  });

  it('carries a server-side message', () => {
    expect(constraint.defaultMessage()).toContain('positive decimal');
  });
});

describe('IsDecimalStringConstraint', () => {
  const constraint = new IsDecimalStringConstraint();

  it('delegates to isDecimalString', () => {
    expect(constraint.validate('4000000')).toBe(true);
    expect(constraint.validate('abc')).toBe(false);
  });

  it('carries a server-side message', () => {
    expect(constraint.defaultMessage()).toContain('decimal amount');
  });
});

function args(object: Record<string, unknown>): ValidationArguments {
  return {
    object,
    property: 'warnAboveAmount',
    value: object['warnAboveAmount'],
    constraints: [],
    targetName: 'UpsertBudgetCeilingDto',
  };
}

describe('WarnAboveNotExceedingCeilingConstraint (ck_tbc_warn, TC-27)', () => {
  const constraint = new WarnAboveNotExceedingCeilingConstraint();

  it('passes when warnAboveAmount is undefined or null — @IsOptional already covers absence', () => {
    expect(constraint.validate(undefined, args({ maxCampaignBudget: '5000000' }))).toBe(true);
    expect(constraint.validate(null, args({ maxCampaignBudget: '5000000' }))).toBe(true);
  });

  it('passes (defers to IsDecimalString) when the value itself is not a well-formed decimal', () => {
    expect(constraint.validate('abc', args({ maxCampaignBudget: '5000000' }))).toBe(true);
  });

  it('passes when maxCampaignBudget is missing or malformed — nothing to compare against yet', () => {
    expect(constraint.validate('4000000', args({}))).toBe(true);
    expect(constraint.validate('4000000', args({ maxCampaignBudget: 'abc' }))).toBe(true);
  });

  it('passes when warnAboveAmount is at or below the ceiling (TC-21)', () => {
    expect(constraint.validate('4000000', args({ maxCampaignBudget: '5000000' }))).toBe(true);
    expect(constraint.validate('5000000', args({ maxCampaignBudget: '5000000' }))).toBe(true);
  });

  it('fails when warnAboveAmount exceeds the ceiling (TC-27)', () => {
    expect(constraint.validate('6000000', args({ maxCampaignBudget: '5000000' }))).toBe(false);
  });

  it('works with no ValidationArguments at all (defensive — validate() may be called directly)', () => {
    expect(constraint.validate('4000000', undefined)).toBe(true);
  });

  it('carries a server-side message', () => {
    expect(constraint.defaultMessage()).toContain('maxCampaignBudget');
  });
});
