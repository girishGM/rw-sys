/**
 * T-RR-024. Placeholder re-export — see this task's own implementation note 1 and
 * `redemption-processing-orchestrator.service.ts`'s own header for the full story.
 *
 * When this task was written, Wave 3's `RewardSystemConnector` interface (`T-RR-030`) did not yet
 * exist, so this task's own scope called for defining a small, stable copy here as a placeholder
 * Wave 3 would "adopt as-is or supersede." By the time this task actually ran, `T-RR-030` had
 * already landed (`src/modules/connectors/reward-system-connector.interface.ts`, `review` status in
 * `progress.json`) with the *exact* shape this task's own note anticipated
 * (`redeem(entry, connectorConfig): Promise<RedemptionResult>`,
 * `08-EXTERNAL-INTEGRATION-CONTRACTS.md` §1). Rather than hand-declare a second, competing copy of
 * the same types that could silently drift from the real one, this file re-exports T-RR-030's own
 * definitions verbatim — the file exists (satisfying this task's own "Files owned" list) but
 * carries no type of its own. `redemption-processing-orchestrator.service.ts` itself imports
 * directly from T-RR-030's own file, not from this re-export, to keep the dependency explicit.
 */
export type {
  ClaimedRewardEntry,
  ExternalRewardSystemConfig,
  RedemptionResult,
  RewardSystemConnector,
} from '@/modules/connectors/reward-system-connector.interface';
