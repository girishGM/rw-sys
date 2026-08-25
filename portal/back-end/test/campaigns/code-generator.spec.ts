/**
 * T-037 — the generated tracker/component codes.
 *
 * The property under test is not "it produces a string" but "it produces a string the column can
 * hold, that a human can trace back to a campaign, and that does not repeat".
 */
import { buildCode } from '@/modules/campaigns/code-generator';
import {
  COMPONENT_CODE_PREFIX,
  GENERATED_CODE_MAX_LENGTH,
  TRACKER_CODE_PREFIX,
} from '@/modules/campaigns/campaigns.constants';

describe('T-037 code generator', () => {
  it('embeds the prefix and the campaign id, so a raw code is traceable in production', () => {
    expect(buildCode(TRACKER_CODE_PREFIX, 812)).toMatch(/^TRK-812-[A-Z0-9]{6}$/);
    expect(buildCode(COMPONENT_CODE_PREFIX, 812)).toMatch(/^CMP-812-[A-Z0-9]{6}$/);
  });

  it('never exceeds the column width, even for an implausibly large campaign id', () => {
    const code = buildCode(TRACKER_CODE_PREFIX, Number.MAX_SAFE_INTEGER);
    expect(code.length).toBeLessThanOrEqual(GENERATED_CODE_MAX_LENGTH);
  });

  it('does not repeat across many calls for one campaign', () => {
    // 2.2 billion values per prefix; 500 draws colliding would be a broken generator, not luck.
    const codes = new Set(Array.from({ length: 500 }, () => buildCode(TRACKER_CODE_PREFIX, 1)));
    expect(codes.size).toBe(500);
  });

  it('uses only characters the column and a URL both tolerate', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(buildCode(COMPONENT_CODE_PREFIX, index)).toMatch(/^[A-Z0-9-]+$/);
    }
  });
});
