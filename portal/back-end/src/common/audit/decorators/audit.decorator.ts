/**
 * T-014 — `@Audit({ event, targetType })`, the declaration that a handler is worth recording.
 *
 * ```ts
 * // an access-control change → reward_portal.portal_audit_log
 * @Audit({ event: 'nav_config_updated', targetType: 'role_nav_config' })
 * @Patch('nav/:role')
 * updateNav(...) { ... }
 *
 * // a campaign change → reward_config.campaign_audit_trail
 * @Audit({ store: 'campaign', event: 'updated', targetType: 'campaign' })
 * @Patch(':id')
 * update(...) { ... }
 * ```
 *
 * ### Why `store` is a required discriminator on the domain side
 *
 * Implementation note 1 and 01-DATABASE.md §2.5 are emphatic that the two stores must not be
 * mixed: *"Do not write domain events to the portal log or vice versa."* A default of "portal"
 * with an opt-in `store: 'campaign'` makes the portal log the thing you get when you do not
 * think about it — and the portal log is the harmless place to land, since it is the portal's
 * own table with no retention or approval semantics attached. The dangerous direction (a
 * campaign change silently recorded outside the 7-year, approval-aware trail) requires typing
 * the word `campaign`, and the discriminated union then *forces* `event` to be one of the nine
 * actions the table's `CHECK` constraint permits and `targetType` one of its nine entity types.
 *
 * An unaudited handler is unaffected by any of this: no decorator, no row, no interceptor work.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { CampaignAuditAction, CampaignAuditEntityType } from '../audit.constants';

/** Metadata key. Exported so the interceptor's spec can set it without the decorator. */
export const AUDIT_METADATA = 'rs:audit';

/** An auth / access-control / admin event → `reward_portal.portal_audit_log`. */
export interface PortalAuditOptions {
  readonly store?: 'portal';
  /** `event_type`, `varchar(60)`. Snake case, past tense: `nav_config_updated`. */
  readonly event: string;
  /** `target_type`, `varchar(60)`. The kind of thing acted on: `role_nav_config`, `user`. */
  readonly targetType?: string;
}

/** A campaign / domain change → `reward_config.campaign_audit_trail`. */
export interface DomainAuditOptions {
  readonly store: 'campaign';
  /** `action` — constrained by `ck_cat_action` on the live table. */
  readonly event: CampaignAuditAction;
  /** `entity_type` — constrained by `ck_cat_entity_type` on the live table. */
  readonly targetType: CampaignAuditEntityType;
}

export type AuditOptions = PortalAuditOptions | DomainAuditOptions;

/** Narrowing helper, used by the interceptor and by tests. */
export function isDomainAudit(options: AuditOptions): options is DomainAuditOptions {
  return options.store === 'campaign';
}

/**
 * Marks a handler for auditing. The row is written by `AuditInterceptor` **only if the handler
 * succeeds** (implementation note 2, TC-6).
 */
export const Audit = (options: AuditOptions): CustomDecorator<string> =>
  SetMetadata(AUDIT_METADATA, options);
