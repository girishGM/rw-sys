/**
 * T-045 — the `campaign_audit_trail` correlation-id lookup (`domain-audit-query.ts`). The two
 * properties that matter: the pattern matches exactly what `AuditRepository
 * .serialiseFieldChanges` writes, and an id containing `LIKE`'s own wildcard characters cannot
 * widen the match.
 */
import { literal } from 'sequelize';
import {
  correlationLikePattern,
  domainAuditCorrelationWhere,
  DOMAIN_CORRELATION_KEY,
  escapeLikePattern,
} from '@/modules/trace/domain-audit-query';

describe('escapeLikePattern', () => {
  it('leaves an ordinary alphanumeric id untouched', () => {
    expect(escapeLikePattern('01J8F3K9QP2M7N')).toBe('01J8F3K9QP2M7N');
  });

  it('escapes %, _ and \\ — the three characters LIKE treats specially', () => {
    expect(escapeLikePattern('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
  });

  it('a correlation id containing an underscore only matches itself, not a wildcard family', () => {
    // Without escaping, `has_wildcard` as a LIKE pattern would also match `hasXwildcard`. Only
    // the *id* portion is checked here — the fixed `__correlationId` key text is this module's
    // own compile-time constant, never attacker-controlled, so it is not escaped.
    const pattern = correlationLikePattern('has_wildcard1');
    const idPortion = pattern.slice(pattern.indexOf('":"') + 3, pattern.lastIndexOf('"%'));
    expect(idPortion).toBe('has\\_wildcard1');
    expect(idPortion).not.toMatch(/(?<!\\)_/);
  });
});

describe('correlationLikePattern', () => {
  it('wraps the escaped id in the exact substring AuditRepository writes', () => {
    const pattern = correlationLikePattern('01J8F3K9QP2M7N');
    expect(pattern).toBe(`%"${DOMAIN_CORRELATION_KEY}":"01J8F3K9QP2M7N"%`);

    // Matches what `serialiseFieldChanges` actually produces, both with and without a diff.
    const withDiff = JSON.stringify({
      status: 'active',
      [DOMAIN_CORRELATION_KEY]: '01J8F3K9QP2M7N',
    });
    const withoutDiff = JSON.stringify({ [DOMAIN_CORRELATION_KEY]: '01J8F3K9QP2M7N' });
    const asRegex = new RegExp(
      pattern
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/%/g, '.*')
        .replace(/\\_/g, '_'),
    );
    expect(asRegex.test(withDiff)).toBe(true);
    expect(asRegex.test(withoutDiff)).toBe(true);
  });
});

describe('domainAuditCorrelationWhere', () => {
  it('returns a literal WHERE clause bound through a named replacement', () => {
    const { where, replacements } = domainAuditCorrelationWhere('01J8F3K9QP2M7N');

    expect(where).toEqual(literal(`field_changes LIKE :domainCorrelationPattern ESCAPE '\\'`));
    expect(replacements).toEqual({
      domainCorrelationPattern: correlationLikePattern('01J8F3K9QP2M7N'),
    });
  });

  it('never interpolates the id into the SQL text itself', () => {
    const { where } = domainAuditCorrelationWhere("'; DROP TABLE campaign_audit_trail; --");
    // The literal's own SQL text is a compile-time constant of the module; a malicious id can
    // only ever land inside the bound replacement value, never inside this string.
    expect(JSON.stringify(where)).not.toContain('DROP TABLE');
  });
});
