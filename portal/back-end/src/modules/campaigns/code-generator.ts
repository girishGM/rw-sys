/**
 * T-037 — the tenant-unique codes the wizard generates on the maker's behalf.
 *
 * `trackers.tracker_code` and `tracker_components.component_code` are both `NOT NULL` with a
 * `unique (tenant_id, <code>)` constraint, but 04-FRONTEND.md §5.3's journey builder never asks
 * for either: adding a "code" field to a two-pane visual builder is exactly the incidental
 * complexity that design leaves out, and a maker has no basis on which to choose one.
 *
 * ### Why random rather than sequential
 *
 * A sequential scheme (`TRK-<campaignId>-1`, `-2`, …) needs the current maximum, which means a
 * read plus a write with nothing serialising them: two components added from two browser tabs
 * both compute `-3` and one insert fails. Worse, after a component is removed the next insert
 * reuses a code a previous row held, which makes the audit trail ambiguous.
 *
 * A random suffix has neither problem. Six base-36 characters is ~2.2 billion values per prefix,
 * so a collision inside one tenant is vanishingly unlikely — and when one does happen it is
 * caught by the unique constraint and retried, which is the only correct way to handle it
 * anyway. After {@link ATTEMPTS} collisions something other than chance is wrong (a truncated
 * prefix colliding, say) and failing loudly beats looping.
 *
 * The campaign id is kept in the code because it makes a raw `tracker_code` readable to a human
 * debugging production, which is the only audience these values have.
 */
import { randomInt } from 'node:crypto';
import { CODE_GENERATION_ATTEMPTS, GENERATED_CODE_MAX_LENGTH } from './campaigns.constants';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const SUFFIX_LENGTH = 6;

export const ATTEMPTS = CODE_GENERATION_ATTEMPTS;

/**
 * `<prefix>-<campaignId>-<random>`, clamped to the column width.
 *
 * `randomInt` from `node:crypto`, not `Math.random`: these values are not secrets, but a
 * predictable generator is one of those choices that is free to make correctly now and awkward
 * to change once rows exist. `randomInt` is also uniform, which `Math.floor(Math.random() * n)`
 * is not quite.
 */
export function buildCode(prefix: string, campaignId: number): string {
  let suffix = '';
  for (let index = 0; index < SUFFIX_LENGTH; index += 1) {
    suffix += ALPHABET[randomInt(ALPHABET.length)];
  }
  return `${prefix}-${String(campaignId)}-${suffix}`.slice(0, GENERATED_CODE_MAX_LENGTH);
}
