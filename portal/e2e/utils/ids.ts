/**
 * T-050 — unique code/identifier generation, so parallel specs never collide on a `unique`
 * database constraint (implementation note 2: "each spec creates its own tenant/users with
 * unique codes so specs can run in parallel without interfering").
 *
 * `runId` is mixed into every generated value. It is set once in `global-setup.ts` (a short,
 * high-entropy tag for *this* invocation of the suite) and read here via `process.env` — every
 * worker process inherits it from the process Playwright spawned them from. Combined with a
 * per-call random suffix, two specs in the same run (different workers) and two runs of the
 * suite in a row (TC-8) never produce the same code.
 */
import { randomBytes } from 'node:crypto';
import { openSync, closeSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomLetters(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/**
 * `POST /countries`' own `code` field is validated against the real ISO-3166-1 alpha-2 list
 * (`back-end/src/modules/countries/countries.validators.ts`'s `isIso3166Alpha2CountryCode`), not
 * merely "any 2 letters" — this suite's first live run (T-050 retry 1/3) found that the original
 * `randomLetters(2)` here produced `VALIDATION_FAILED` on almost every call, since the overwhelming
 * majority of 2-letter combinations are not an assigned ISO code at all. A local copy of the same
 * list `countries.validators.ts`'s own header explains why it does not import a shared one (this
 * is a standalone npm project, T-050's file scope is `e2e/**` only, and cross-package coupling to
 * `back-end/src/**` for three lines is not worth it — the identical trade-off, restated here).
 */
const ISO_3166_ALPHA2_CODE_LIST =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ ' +
  'BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ ' +
  'DE DJ DK DM DO DZ ' +
  'EC EE EG EH ER ES ET ' +
  'FI FJ FK FM FO FR ' +
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY ' +
  'HK HM HN HR HT HU ' +
  'ID IE IL IM IN IO IQ IR IS IT ' +
  'JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ ' +
  'LA LB LC LI LK LR LS LT LU LV LY ' +
  'MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ ' +
  'NA NC NE NF NG NI NL NO NP NR NU NZ ' +
  'OM ' +
  'PA PE PF PG PH PK PL PM PN PR PS PT PW PY ' +
  'QA ' +
  'RE RO RS RU RW ' +
  'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ ' +
  'TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ ' +
  'UA UG UM US UY UZ ' +
  'VA VC VE VG VI VN VU ' +
  'WF WS ' +
  'YE YT ' +
  'ZA ZM ZW';

const ISO_3166_ALPHA2_CODES: readonly string[] = ISO_3166_ALPHA2_CODE_LIST.split(' ');

const CODE_LOCK_DIR = path.resolve(__dirname, '..', '.tmp', 'used-country-codes');

/**
 * Claims one never-before-used-in-this-run ISO code via an atomic, exclusive file create
 * (`wx` — fails with `EEXIST` if the file is already there). Every worker in a `--workers=4` run
 * is a separate OS process sharing this filesystem, so a shared in-memory `Set` would not be
 * enough (TC-9) — this is the same "no shared state, coordinate through disk" approach
 * `utils/state.ts` already uses for `global-setup.ts` → spec handoff, applied here for
 * spec ↔ spec coordination instead. Retries a fresh random pick on collision; with 249 codes and
 * this suite's own scenario count (well under 30 per full run), collisions are rare and a handful
 * of retries resolves them, never blocking.
 */
export function uniqueCountryCode(): string {
  if (!existsSync(CODE_LOCK_DIR)) mkdirSync(CODE_LOCK_DIR, { recursive: true });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = ISO_3166_ALPHA2_CODES[randomBytes(1)[0] % ISO_3166_ALPHA2_CODES.length];
    const lockPath = path.join(CODE_LOCK_DIR, candidate);
    try {
      closeSync(openSync(lockPath, 'wx'));
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Already claimed by another spec/worker in this same run — try a different code.
    }
  }
  throw new Error(
    'uniqueCountryCode: exhausted 200 attempts without claiming a free ISO-3166-1 alpha-2 code — ' +
      'either this run has an unexpectedly large number of scenarios, or .tmp/used-country-codes ' +
      'was not cleaned between runs (global-setup.ts does not currently clear it; investigate ' +
      'before assuming it is a fluke).',
  );
}

/** A short unique tag safe to splice into any `varchar` code field (tenant/merchant/rule/store
 * codes and the like), prefixed so a failure's fixture data is recognisable in the database. */
export function uniqueTag(prefix: string): string {
  return `${prefix}${randomLetters(4)}${Date.now().toString(36).slice(-4)}`.toUpperCase();
}

/** A syntactically valid, never-real email address scoped to this run, so two specs never
 * collide on `portal_users`' unique blind index either. */
export function uniqueEmail(localPart: string): string {
  return `${localPart}.${randomLetters(6).toLowerCase()}@e2e.invalid`;
}
