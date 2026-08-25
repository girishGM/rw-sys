/**
 * T-045 — finding `reward_config.campaign_audit_trail` rows for a correlation id, given that the
 * id lives inside the `field_changes` free-text column rather than in a column of its own.
 *
 * `audit.repository.ts` (T-019/T-014) explains why there is no column: `campaign_audit_trail` is
 * `reward_config`'s, R1 forbids adding one, and the id is instead carried under a reserved key
 * (`DOMAIN_CORRELATION_KEY = '__correlationId'`) inside the column's existing JSON text —
 * *"queryable — `field_changes::jsonb ->> '__correlationId' = :cid` — though unindexed"*, per that
 * file's own comment.
 *
 * ### Why this file does not use the `::jsonb` cast that comment suggests
 *
 * `campaign_audit_trail` predates the portal (01-DATABASE.md §2.5) and `field_changes` is legacy
 * free-text: rows written before T-019 — and any written by another system entirely — are not
 * guaranteed to be valid JSON. `'not json at all'::jsonb` raises a Postgres error, and one
 * malformed historical row would then fail the *entire* query, taking down every trace lookup
 * with it. A plain `LIKE` substring match never parses the column, so a legacy row is simply not
 * matched rather than aborting the search.
 *
 * The substring this searches for is exactly what `AuditRepository.serialiseFieldChanges` writes:
 * `JSON.stringify({ ...fieldChanges, __correlationId: id })` always contains the literal text
 * `"__correlationId":"<id>"` somewhere in its output, regardless of what else is in the object or
 * where key ordering places it.
 */
import { literal, type WhereOptions } from 'sequelize';

/** The reserved key `audit.repository.ts` writes — duplicated rather than imported: that file is
 * owned by `common/audit/**`, outside this task's file scope (AGENT-PROTOCOL R9). A shared
 * constant would be the better long-term home; flagged in the T-045 completion report. */
export const DOMAIN_CORRELATION_KEY = '__correlationId';

/**
 * Escapes the three characters `LIKE` treats specially, so the id is matched as a literal
 * substring and not as a pattern. `%` and `_` are `LIKE` wildcards; `\` is the escape character
 * itself. 08-OBSERVABILITY.md §1's own charset (`[A-Za-z0-9_-]{8,64}`) already excludes `%` and
 * `\`, but **includes `_`**, so this is not a defensive no-op — an unescaped id containing `_`
 * would silently match a wider set of rows than the exact one being asked for.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** The literal substring a matching row's `field_changes` contains, `LIKE`-escaped. */
export function correlationLikePattern(correlationId: string): string {
  return `%"${DOMAIN_CORRELATION_KEY}":"${escapeLikePattern(correlationId)}"%`;
}

/**
 * The `WHERE` fragment plus its bound replacement, ready to hand to
 * `ScopedRepository.listAll(CampaignAuditTrail, { where, replacements })`.
 *
 * `literal()` here is the same pattern `scope-strategy.ts`'s subquery rules use, for the same
 * reason its header gives: the SQL text (`field_changes LIKE :domainCorrelationPattern ESCAPE
 * '\\'`) is a compile-time constant of this file, and the only value in it is bound through
 * `replacements`, which Sequelize escapes and which throws if the binding is ever dropped.
 */
export function domainAuditCorrelationWhere(correlationId: string): {
  readonly where: WhereOptions;
  readonly replacements: Readonly<Record<string, string>>;
} {
  return {
    where: literal(`field_changes LIKE :domainCorrelationPattern ESCAPE '\\'`),
    replacements: { domainCorrelationPattern: correlationLikePattern(correlationId) },
  };
}
