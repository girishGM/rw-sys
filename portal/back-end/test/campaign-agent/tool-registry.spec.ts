/**
 * T-048 — the closed tool whitelist (`tools/tool-registry.ts`), 10-AI-CAMPAIGN-AGENT.md §5.
 *
 * TC-11 and TC-16 are both statements about a capability **not existing**, and the only honest way
 * to test a non-existent capability is to assert that the registry is exactly §5's list and nothing
 * else. A test that only checked `isToolName('executeSql') === false` would keep passing after
 * somebody added `writeAnyTable`.
 */
import {
  isModelInvocable,
  isToolName,
  MODEL_INVOCABLE_TOOLS,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
} from '@/modules/campaign-agent/tools/tool-registry';

describe('the whitelist is exactly §5’s table', () => {
  it('contains these nine tools and no others', () => {
    expect([...TOOL_NAMES]).toEqual([
      'searchMerchants',
      'listMerchantActivities',
      'listAvailableRules',
      'getRuleParameters',
      'listAvailableRewards',
      'getRewardPolicies',
      'validateSlots',
      'buildPlan',
      'createCampaignDraft',
    ]);
  });

  it('has no SQL, no write-anything and no rule-authoring capability — TC-11', () => {
    // §5: "There is no executeSql, no writeAnyTable, no createRule, no submitForApproval.
    // A capability that does not exist cannot be talked into existing."
    for (const forbidden of [
      'executeSql',
      'runSql',
      'query',
      'writeAnyTable',
      'createRule',
      'updateRule',
      'createReward',
      'submitForApproval',
      'submitCampaign',
      'approveCampaign',
      'deleteCampaign',
    ]) {
      expect(isToolName(forbidden)).toBe(false);
    }
  });

  it('rejects non-string and empty input', () => {
    expect(isToolName(undefined)).toBe(false);
    expect(isToolName(null)).toBe(false);
    expect(isToolName(42)).toBe(false);
    expect(isToolName('')).toBe(false);
  });

  it('every tool has a description, so the prompt cannot silently omit one', () => {
    for (const name of TOOL_NAMES) {
      expect(TOOL_DESCRIPTIONS[name].length).toBeGreaterThan(20);
    }
  });
});

describe('what a model turn may invoke', () => {
  it('is the eight read-and-plan tools', () => {
    expect([...MODEL_INVOCABLE_TOOLS]).toEqual([
      'searchMerchants',
      'listMerchantActivities',
      'listAvailableRules',
      'getRuleParameters',
      'listAvailableRewards',
      'getRewardPolicies',
      'validateSlots',
      'buildPlan',
    ]);
  });

  it('excludes createCampaignDraft — only a human click reaches it (§3.2, TC-16)', () => {
    expect(isModelInvocable('createCampaignDraft')).toBe(false);
  });

  it('every model-invocable name is a real tool', () => {
    for (const name of MODEL_INVOCABLE_TOOLS) {
      expect(isToolName(name)).toBe(true);
    }
  });
});
