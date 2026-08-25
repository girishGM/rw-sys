/**
 * T-037 — "does this tracker / component belong to *this* campaign?", answered in one place.
 *
 * ### Why this needs a helper at all
 *
 * `trackers` and `tracker_components` are **tenant**-scoped, not campaign-scoped: neither table
 * has a `campaign_id` column (see `tracker-component.model.ts`'s header). A campaign reaches its
 * trackers through `tenant_campaign_trackers`, and a tracker reaches its components through
 * `tracker_tracker_components`. So `ScopedRepository` — which correctly stops a maker touching
 * *another tenant's* tracker — cannot by itself stop them touching **their own tenant's tracker
 * that belongs to a different campaign**.
 *
 * That is precisely TC-21q: *"rule attached to a component in another campaign → 400 —
 * components are campaign-scoped"*. It is not a tenancy hole (the row is legitimately theirs)
 * but it is a correctness hole with a nasty shape: a rule silently added to somebody else's live
 * campaign, from a wizard that showed no sign of having done so.
 *
 * Every write path in this module that accepts a `trackerId`, `componentId` or cap `scopeRefId`
 * from the client calls one of these functions first. They are collected here, rather than
 * repeated per service, so "did this endpoint check membership?" is answered by grepping for one
 * import instead of by reading twelve methods.
 *
 * Both functions go through `ScopedRepository`, so the tenancy check still happens too — this is
 * an **additional** predicate, never a replacement for one.
 */
import { Op, type Transaction } from 'sequelize';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { TenantCampaignTracker, TrackerTrackerComponent } from '@/database/models';
import { ROW_ACTIVE } from './campaigns.constants';
import { NotPartOfCampaignError } from './campaigns.errors';
import { firstOrNull } from './scoped-lookup';

/** Every tracker id linked to `campaignId`, active links only. */
export async function trackerIdsOfCampaign(
  scoped: ScopedRepository,
  campaignId: number,
  transaction?: Transaction,
): Promise<number[]> {
  const links = await scoped.listAll(TenantCampaignTracker, {
    where: { campaignId, status: ROW_ACTIVE },
    order: [['id', 'ASC']],
    transaction,
  });
  return links.map((link) => link.trackerId);
}

/** The `tenant_campaign_trackers` link rows of `campaignId`, in a stable order. */
export async function campaignTrackerLinks(
  scoped: ScopedRepository,
  campaignId: number,
  transaction?: Transaction,
): Promise<TenantCampaignTracker[]> {
  return scoped.listAll(TenantCampaignTracker, {
    where: { campaignId, status: ROW_ACTIVE },
    order: [['id', 'ASC']],
    transaction,
  });
}

/** Every `tracker_tracker_components` row of `campaignId`, across all its trackers. */
export async function componentLinksOfCampaign(
  scoped: ScopedRepository,
  campaignId: number,
  transaction?: Transaction,
): Promise<TrackerTrackerComponent[]> {
  const trackerIds = await trackerIdsOfCampaign(scoped, campaignId, transaction);
  if (trackerIds.length === 0) return [];
  return scoped.listAll(TrackerTrackerComponent, {
    where: { trackerId: { [Op.in]: trackerIds } },
    order: [
      ['trackerId', 'ASC'],
      ['sequenceOrder', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction,
  });
}

/** `trackerId`, or a 400 when it is not part of `campaignId` (TC-21q's tracker half). */
export async function assertTrackerInCampaign(
  scoped: ScopedRepository,
  campaignId: number,
  trackerId: number,
  transaction?: Transaction,
): Promise<TenantCampaignTracker> {
  const link = await firstOrNull(scoped, TenantCampaignTracker, {
    where: { campaignId, trackerId, status: ROW_ACTIVE },
    transaction,
  });
  if (link === null) throw new NotPartOfCampaignError('trackerId', trackerId);
  return link;
}

/** The component's link row, or a 400 when the component is not part of `campaignId` (TC-21q). */
export async function assertComponentInCampaign(
  scoped: ScopedRepository,
  campaignId: number,
  componentId: number,
  transaction?: Transaction,
): Promise<TrackerTrackerComponent> {
  const trackerIds = await trackerIdsOfCampaign(scoped, campaignId, transaction);
  if (trackerIds.length > 0) {
    const link = await firstOrNull(scoped, TrackerTrackerComponent, {
      where: { componentId, trackerId: { [Op.in]: trackerIds } },
      transaction,
    });
    if (link !== null) return link;
  }
  throw new NotPartOfCampaignError('componentId', componentId);
}

/**
 * A cap's `scopeRefId`, checked against the level it claims.
 *
 * Without this, a maker could attach an MYR 50,000 tracker budget to a tracker in a colleague's
 * campaign — the cap row would carry this campaign's `campaign_id` and a foreign campaign's
 * `scope_ref_id`, which no constraint forbids and which the runtime would resolve to something
 * nobody intended.
 */
export async function assertCapScopeRef(
  scoped: ScopedRepository,
  campaignId: number,
  scopeLevel: string,
  scopeRefId: number | null | undefined,
  transaction?: Transaction,
): Promise<void> {
  if (scopeLevel === 'campaign' || scopeRefId === null || scopeRefId === undefined) return;
  if (scopeLevel === 'tracker') {
    await assertTrackerInCampaign(scoped, campaignId, scopeRefId, transaction);
    return;
  }
  await assertComponentInCampaign(scoped, campaignId, scopeRefId, transaction);
}
