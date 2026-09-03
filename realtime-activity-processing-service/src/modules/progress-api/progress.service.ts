/**
 * T-RAP-040. Combines the two indexed reads (`ProgressRepository`) into the response shape
 * Implementation note 3 requires — no aggregation logic of its own (Scope "Out": "this task only
 * surfaces the already-materialized result").
 *
 * **R4 applies to this read path exactly as it does to every write path**: the only plaintext
 * `customerId` this service ever sees is the one the caller already supplied on the request path
 * (the guard already proved the caller is authorized for it — `progress-api-auth.guard.ts`); it is
 * hashed via `EncryptionService.hash` before touching a single query and is never logged, and the
 * response never echoes anything derived from `customer_id_encrypted`.
 */
import { Injectable } from '@nestjs/common';
import { EncryptionService } from '@/modules/encryption/encryption.service';
import type { CustomerTrackerComponentProgressRow } from '@/database/models/customer-tracker-component-progress.model';
import type { CustomerTrackerStatusRow } from '@/database/models/customer-tracker-status.model';
import { ProgressRepository } from './progress.repository';
import type {
  CampaignProgressResponse,
  ComponentProgressView,
  TrackerProgressResponse,
  TrackerProgressView,
} from './progress.types';

function toComponentView(row: CustomerTrackerComponentProgressRow): ComponentProgressView {
  return {
    componentCode: row.tracker_component_code,
    currentCount: row.current_count,
    requiredCount: row.required_count,
    isCompleted: row.is_completed,
  };
}

/** Groups the (already latest-cycle-only) component rows by their own `tracker_code`. */
function groupComponentsByTracker(
  rows: CustomerTrackerComponentProgressRow[],
): Map<string, CustomerTrackerComponentProgressRow[]> {
  const byTracker = new Map<string, CustomerTrackerComponentProgressRow[]>();
  for (const row of rows) {
    const existing = byTracker.get(row.tracker_code);
    if (existing) {
      existing.push(row);
    } else {
      byTracker.set(row.tracker_code, [row]);
    }
  }
  return byTracker;
}

@Injectable()
export class ProgressService {
  constructor(
    private readonly repository: ProgressRepository,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * All trackers this customer has any materialized progress on, for one campaign (TC-1/TC-2).
   * TC-3: no progress rows at all for this customer/campaign resolves to `trackers: []` — a normal
   * 200, never a 404 (a customer legitimately hasn't started yet).
   */
  async getCampaignProgress(
    tenantId: number,
    customerId: string,
    campaignCode: string,
  ): Promise<CampaignProgressResponse> {
    const customerIdHash = this.encryption.hash(customerId);

    const [componentRows, statusRows, completionLogicByTracker] = await Promise.all([
      this.repository.findLatestComponentProgress(tenantId, customerIdHash, campaignCode),
      this.repository.findLatestTrackerStatus(tenantId, customerIdHash, campaignCode),
      this.repository.findCampaignConfigSnapshotTrackers(tenantId, campaignCode),
    ]);

    const componentsByTracker = groupComponentsByTracker(componentRows);
    const statusByTracker = new Map(statusRows.map((row) => [row.tracker_code, row]));

    const trackerCodes = new Set<string>([
      ...componentsByTracker.keys(),
      ...statusByTracker.keys(),
    ]);
    const trackers: TrackerProgressView[] = [...trackerCodes]
      .sort()
      .map((trackerCode) =>
        this.buildTrackerView(
          trackerCode,
          componentsByTracker.get(trackerCode) ?? [],
          statusByTracker.get(trackerCode) ?? null,
          completionLogicByTracker,
        ),
      );

    return { customerId, campaignCode, trackers };
  }

  /**
   * One tracker's own progress (TC-1/TC-2 narrowed, TC-3's "no activity" generalized to a single
   * tracker too): zeroed, not an error, when this customer has no materialized progress on this
   * specific tracker yet.
   */
  async getTrackerProgress(
    tenantId: number,
    customerId: string,
    campaignCode: string,
    trackerCode: string,
  ): Promise<TrackerProgressResponse> {
    const customerIdHash = this.encryption.hash(customerId);

    const [componentRows, statusRows, completionLogicByTracker] = await Promise.all([
      this.repository.findLatestComponentProgress(
        tenantId,
        customerIdHash,
        campaignCode,
        trackerCode,
      ),
      this.repository.findLatestTrackerStatus(tenantId, customerIdHash, campaignCode, trackerCode),
      this.repository.findCampaignConfigSnapshotTrackers(tenantId, campaignCode),
    ]);

    const tracker = this.buildTrackerView(
      trackerCode,
      componentRows,
      statusRows[0] ?? null,
      completionLogicByTracker,
    );

    return { customerId, campaignCode, ...tracker };
  }

  private buildTrackerView(
    trackerCode: string,
    componentRows: CustomerTrackerComponentProgressRow[],
    status: CustomerTrackerStatusRow | null,
    completionLogicByTracker: Map<string, string> | null,
  ): TrackerProgressView {
    const components = componentRows.map(toComponentView);
    const componentsCompletedCount =
      status?.components_completed_count ?? components.filter((c) => c.isCompleted).length;
    const componentsRequiredCount = status?.components_required_count ?? components.length;

    return {
      trackerCode,
      completionLogic: completionLogicByTracker?.get(trackerCode) ?? null,
      isCompleted: status?.is_completed ?? false,
      completedAt: status?.completed_at ? status.completed_at.toISOString() : null,
      componentsRequiredCount,
      componentsCompletedCount,
      components,
    };
  }
}
