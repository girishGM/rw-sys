/**
 * T-RAP-043. Unit tests for `MetricsService` — no DB, no Nest test module: a plain in-memory
 * service, constructed directly.
 */
import { MetricsService, elapsedSeconds } from '@/observability/metrics.service';

describe('MetricsService', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
  });

  // TC-1
  it('activities_ingested_total{transport} increments per transport, independently', () => {
    metrics.incrementActivitiesIngested('grpc');
    metrics.incrementActivitiesIngested('grpc');
    metrics.incrementActivitiesIngested('kafka');

    expect(metrics.getCounterValue('activities_ingested_total', { transport: 'grpc' })).toBe(2);
    expect(metrics.getCounterValue('activities_ingested_total', { transport: 'kafka' })).toBe(1);
  });

  // TC-1
  it('activity_logs_fanout_total increments by the actual inserted-row count, not a flat 1', () => {
    metrics.incrementActivityLogsFanout(3);
    metrics.incrementActivityLogsFanout(2);

    expect(metrics.getCounterValue('activity_logs_fanout_total')).toBe(5);
  });

  // TC-1
  it('tracker_components_completed_total{campaign_code} is labeled per campaign', () => {
    metrics.incrementTrackerComponentsCompleted('CAMP1');
    metrics.incrementTrackerComponentsCompleted('CAMP1');
    metrics.incrementTrackerComponentsCompleted('CAMP2');

    expect(
      metrics.getCounterValue('tracker_components_completed_total', { campaign_code: 'CAMP1' }),
    ).toBe(2);
    expect(
      metrics.getCounterValue('tracker_components_completed_total', { campaign_code: 'CAMP2' }),
    ).toBe(1);
  });

  // TC-1
  it('rewards_created_total{campaign_code,reward_category} requires both labels to match', () => {
    metrics.incrementRewardsCreated('CAMP1', 'POINTS');
    metrics.incrementRewardsCreated('CAMP1', 'CASHBACK');
    metrics.incrementRewardsCreated('CAMP2', 'POINTS');

    expect(
      metrics.getCounterValue('rewards_created_total', {
        campaign_code: 'CAMP1',
        reward_category: 'POINTS',
      }),
    ).toBe(1);
    expect(
      metrics.getCounterValue('rewards_created_total', {
        campaign_code: 'CAMP1',
        reward_category: 'CASHBACK',
      }),
    ).toBe(1);
    expect(
      metrics.getCounterValue('rewards_created_total', {
        campaign_code: 'CAMP2',
        reward_category: 'POINTS',
      }),
    ).toBe(1);
    expect(
      metrics.getCounterValue('rewards_created_total', {
        campaign_code: 'CAMP2',
        reward_category: 'CASHBACK',
      }),
    ).toBe(0);
  });

  // TC-3: a budget breach increments budget_breach_total with the correct labels.
  it('budget_breach_total{campaign_code,cap_type} increments exactly once per breach, correctly labeled', () => {
    metrics.incrementBudgetBreach('CAMP1', 'campaign_cap');
    metrics.incrementBudgetBreach('CAMP1', 'customer_limit');

    expect(
      metrics.getCounterValue('budget_breach_total', {
        campaign_code: 'CAMP1',
        cap_type: 'campaign_cap',
      }),
    ).toBe(1);
    expect(
      metrics.getCounterValue('budget_breach_total', {
        campaign_code: 'CAMP1',
        cap_type: 'customer_limit',
      }),
    ).toBe(1);
    // A cap type never observed for this campaign is 0, not undefined/NaN.
    expect(
      metrics.getCounterValue('budget_breach_total', {
        campaign_code: 'CAMP1',
        cap_type: 'nonexistent_cap_type',
      }),
    ).toBe(0);
  });

  // TC-1
  it('dedup_hits_total has no labels and accumulates across every duplicate', () => {
    metrics.incrementDedupHits();
    metrics.incrementDedupHits();
    metrics.incrementDedupHits();

    expect(metrics.getCounterValue('dedup_hits_total')).toBe(3);
  });

  // TC-1
  it('reward_dispatch_tier_total{tier} is labeled per dispatch tier (kafka/grpc/retry_table)', () => {
    metrics.incrementRewardDispatchTier('kafka');
    metrics.incrementRewardDispatchTier('kafka');
    metrics.incrementRewardDispatchTier('grpc');
    metrics.incrementRewardDispatchTier('retry_table');

    expect(metrics.getCounterValue('reward_dispatch_tier_total', { tier: 'kafka' })).toBe(2);
    expect(metrics.getCounterValue('reward_dispatch_tier_total', { tier: 'grpc' })).toBe(1);
    expect(metrics.getCounterValue('reward_dispatch_tier_total', { tier: 'retry_table' })).toBe(1);
  });

  // TC-1
  it('activity_processing_duration_seconds records every observation as a histogram sample', () => {
    metrics.observeActivityProcessingDurationSeconds(0.05);
    metrics.observeActivityProcessingDurationSeconds(0.12);
    metrics.observeActivityProcessingDurationSeconds(1.4);

    const snapshot = metrics.getHistogramSnapshot('activity_processing_duration_seconds');
    expect(snapshot.count).toBe(3);
    expect(snapshot.sum).toBeCloseTo(1.57, 5);
    expect(snapshot.values).toEqual([0.05, 0.12, 1.4]);
  });

  it('rejects a negative or non-finite duration observation rather than silently recording it', () => {
    expect(() => metrics.observeActivityProcessingDurationSeconds(-1)).toThrow();
    expect(() => metrics.observeActivityProcessingDurationSeconds(Number.NaN)).toThrow();
    expect(() =>
      metrics.observeActivityProcessingDurationSeconds(Number.POSITIVE_INFINITY),
    ).toThrow();
  });

  it('a metric never observed at all reads back as zero-valued, not undefined', () => {
    expect(metrics.getCounterValue('activities_ingested_total', { transport: 'grpc' })).toBe(0);
    const snapshot = metrics.getHistogramSnapshot('activity_processing_duration_seconds');
    expect(snapshot).toEqual({ count: 0, sum: 0, values: [] });
  });

  it('resetForTests clears every counter and histogram back to zero', () => {
    metrics.incrementDedupHits();
    metrics.observeActivityProcessingDurationSeconds(1);

    metrics.resetForTests();

    expect(metrics.getCounterValue('dedup_hits_total')).toBe(0);
    expect(metrics.getHistogramSnapshot('activity_processing_duration_seconds').count).toBe(0);
  });

  describe('elapsedSeconds', () => {
    it('computes the difference between two millisecond timestamps, in seconds', () => {
      expect(elapsedSeconds(1_000, 1_450)).toBeCloseTo(0.45, 5);
    });

    it('defaults `endMs` to now when omitted', () => {
      const start = Date.now() - 250;
      expect(elapsedSeconds(start)).toBeGreaterThanOrEqual(0.25);
    });
  });
});
