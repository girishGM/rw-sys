/**
 * T-010 — every tunable number, option and literal the credential layer depends on, in one
 * place so that a reviewer can check the whole policy against
 * [02-SECURITY.md](../../../../project-plan/02-SECURITY.md) §2 and the T-010 task file's
 * Implementation notes without reading three services.
 *
 * **Nothing here is a secret.** The Argon2 parameters, the lockout thresholds and the
 * common-password list are all public knowledge by design — their strength comes from the
 * work factor and the per-hash random salt, not from being hidden. Do not add a pepper, an
 * HMAC key or any other real secret to this file; secrets are resolved through
 * `ConfigModule` (02-SECURITY.md §9) and would be a `scan:secrets` failure here.
 */
import * as argon2 from 'argon2';

/**
 * OWASP's Argon2id baseline, quoted verbatim by T-010 Implementation notes §1:
 * `memoryCost: 19456` KiB (19 MiB), `timeCost: 2`, `parallelism: 1`.
 *
 * These parameters are encoded into every hash string Argon2 emits
 * (`$argon2id$v=19$m=19456,t=2,p=1$…`), so raising them later does **not** invalidate
 * existing hashes: `argon2.verify` reads the cost from the stored digest, and
 * `CredentialService.needsRehash` reports which rows are due for an upgrade on their next
 * successful authentication.
 *
 * Two consequences worth knowing before anyone tunes this:
 *
 *  1. **Every login pays this cost, including logins for addresses that match no account** —
 *     that is deliberate (see `CredentialService.authenticate`) and is what closes the
 *     user-enumeration timing channel. It also makes the login route a CPU-amplification
 *     surface, which is why 02-SECURITY.md §8 (AR-12) requires a global throughput ceiling in
 *     front of it in T-012, sized by a real load test in T-053.
 *  2. **Lowering any of these weakens every stored credential at once.** Raising them is
 *     safe and backwards-compatible; lowering them is not, and must not be done to make a
 *     slow test faster (AGENT-PROTOCOL.md §7).
 */
export const ARGON2_OPTIONS: Readonly<argon2.Options> = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
});

/** The exact prefix every hash produced with {@link ARGON2_OPTIONS} must carry (TC-1). */
export const ARGON2_HASH_PREFIX = '$argon2id$v=19$m=19456,t=2,p=1$';

/** Value written to `portal_user_credentials.password_algo`. */
export const PASSWORD_ALGO = 'argon2id';

// --- Password policy (T-010 Implementation notes §3) --------------------------------------

/** Minimum length. Length is the single most effective composition rule there is. */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Upper bound, and a control rather than a nicety: Argon2's cost is driven by its memory and
 * time parameters, but the input still has to be read and hashed, so an unbounded field is a
 * cheap way for a caller to make the server do unbounded work on a route that is reachable
 * before authentication completes. 256 characters is far beyond any real passphrase.
 */
export const PASSWORD_MAX_LENGTH = 256;

/** How many of {lower, upper, digit, symbol} a password must draw on. */
export const PASSWORD_MIN_CHARACTER_CLASSES = 3;

/**
 * How many superseded hashes `portal_user_credentials.previous_hashes` retains. The reuse
 * check also covers the *current* hash, so in practice a user cannot return to any of their
 * last six passwords — the window named in the spec is the stored history, not the total.
 */
export const PASSWORD_HISTORY_SIZE = 5;

/**
 * A local-part shorter than this is not treated as "the password contains your email",
 * because two- and three-character local parts (`gm@…`, `ops@…`) occur inside perfectly
 * strong passphrases by chance, and rejecting those trains users to pick worse passwords.
 * The full address is matched regardless of length, which is what T-010 TC-9 exercises.
 */
export const PASSWORD_EMAIL_LOCAL_PART_MIN_LENGTH = 4;

// --- Lockout (T-010 Implementation notes §5, 02-SECURITY.md §2) ----------------------------

/** Consecutive failures that trigger a lock. */
export const LOCKOUT_THRESHOLD = 5;

/**
 * Lock duration per lockout *cycle*: the first lock lasts 15 minutes, the second 30, the
 * third 60, the fourth and every subsequent one 120. The cycle is derived from
 * `failed_attempts` (`attempts / LOCKOUT_THRESHOLD`) rather than stored in its own column,
 * because 01-DATABASE.md §2.2 gives us exactly two fields to work with and adding a third
 * would be DDL this task is not authorised to write (AGENT-PROTOCOL.md R1/R9).
 */
export const LOCKOUT_BACKOFF_MINUTES: readonly number[] = Object.freeze([15, 30, 60, 120]);

// --- Login attempt forensics (01-DATABASE.md §2.5) -----------------------------------------

/**
 * `portal_login_attempts.failure_code`. **Operator-facing only.** T-010 Implementation
 * notes §6 and §7 are explicit that no code here may ever reach an API response, and the
 * mechanism that guarantees it is that `InvalidCredentialsError` has nowhere to put one —
 * see `auth.errors.ts`.
 *
 * `no_credential` is an addition to the illustrative list in 01-DATABASE.md §2.5's column
 * comment (there is no CHECK constraint on the column): an account row that exists but has
 * no `portal_user_credentials` row is operationally very different from an address that
 * matches no account — the first is a half-finished provisioning run worth alerting on, the
 * second is ordinary background noise — and collapsing the two would throw away the only
 * signal that distinguishes them. `mfa_failed` is listed for T-055's benefit and is not
 * produced by this task.
 */
export const LOGIN_FAILURE_CODES = [
  'unknown_user',
  'no_credential',
  'inactive',
  'locked',
  'bad_password',
  'mfa_failed',
] as const;

export type LoginFailureCode = (typeof LOGIN_FAILURE_CODES)[number];

/** `portal_login_attempts.email` is `varchar(200)`; `user_agent` is `varchar(400)`. */
export const LOGIN_ATTEMPT_EMAIL_MAX_LENGTH = 200;
export const LOGIN_ATTEMPT_USER_AGENT_MAX_LENGTH = 400;

// --- Common-password list ------------------------------------------------------------------

/**
 * The bundled common-password list (T-010 Implementation notes §3).
 *
 * These are **base forms**: lowercase, undecorated. `PasswordPolicyService` derives a small
 * set of candidate forms from the submitted password — as typed, with leading/trailing
 * non-letters stripped, and with the usual character substitutions folded back — and rejects
 * the password if *any* candidate is in this set. That is what makes `Password123!` (TC-8)
 * fail without needing an entry for every decoration of the word "password", and it is why
 * entries here must stay undecorated.
 *
 * Scope, stated plainly so nobody mistakes this for more than it is: this list stops the few
 * hundred passwords that dominate every credential-stuffing corpus. It is a *filter*, not the
 * control — the controls are length, character classes, per-user reuse history, Argon2id's
 * work factor and lockout, all of which apply to every password including the ones this list
 * has never heard of. Swapping in a full 10k/100k corpus later is a one-constant change and
 * needs no code change; it was left out of the repository on purpose, because a multi-megabyte
 * word list is a build-and-review cost that buys very little on top of a 12-character minimum.
 *
 * None of these strings is a credential for anything in this system. They are the opposite:
 * the strings this system refuses to accept as one.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  // Keyboard walks and digit runs.
  '123456',
  '1234567',
  '12345678',
  '123456789',
  '1234567890',
  '12345',
  '1234',
  '111111',
  '000000',
  '121212',
  '123123',
  '654321',
  '112233',
  '789456',
  'qwerty',
  'qwertyuiop',
  'qwertz',
  'azerty',
  'asdfgh',
  'asdfghjkl',
  'zxcvbn',
  'zxcvbnm',
  '1q2w3e4r',
  '1qaz2wsx',
  'qazwsx',
  'qweasd',
  // The word itself and its immediate relatives.
  'password',
  'passwort',
  'passw',
  'pass',
  'passcode',
  'motdepasse',
  'contrasena',
  'senha',
  'secret',
  'letmein',
  'login',
  'signin',
  'access',
  'default',
  'changeme',
  'temp',
  'temporary',
  'welcome',
  'welcome1',
  'hello',
  'test',
  'testing',
  'demo',
  'sample',
  'example',
  'guest',
  'user',
  'username',
  // Administrative accounts — the ones that matter most in a portal like this one.
  'admin',
  'administrator',
  'adminadmin',
  'superadmin',
  'sysadmin',
  'root',
  'toor',
  'operator',
  'manager',
  'supervisor',
  'support',
  'helpdesk',
  'service',
  'system',
  'oracle',
  'postgres',
  'mysql',
  'database',
  'server',
  'backup',
  'master',
  'public',
  'private',
  // Sentiment and names.
  'iloveyou',
  'loveyou',
  'lovely',
  'sunshine',
  'princess',
  'superman',
  'batman',
  'spiderman',
  'pokemon',
  'starwars',
  'football',
  'baseball',
  'basketball',
  'soccer',
  'hockey',
  'liverpool',
  'chelsea',
  'arsenal',
  'barcelona',
  'realmadrid',
  'juventus',
  'jordan',
  'michael',
  'michelle',
  'jennifer',
  'jessica',
  'ashley',
  'daniel',
  'joshua',
  'andrew',
  'thomas',
  'charlie',
  'george',
  'robert',
  'william',
  'richard',
  'matthew',
  'nicole',
  'hannah',
  'amanda',
  'samantha',
  'anthony',
  'patrick',
  'freedom',
  'whatever',
  'trustno',
  'nothing',
  'shadow',
  'dragon',
  'monkey',
  'phoenix',
  'tigger',
  'ginger',
  'buster',
  'cookie',
  'chocolate',
  'flower',
  'summer',
  'winter',
  'spring',
  'autumn',
  'orange',
  'purple',
  'yellow',
  'silver',
  'golden',
  'diamond',
  'money',
  'banking',
  'internet',
  'computer',
  'samsung',
  'google',
  'facebook',
  'android',
  'windows',
  'microsoft',
  'linkedin',
  'twitter',
  'whatsapp',
  'reward',
  'rewards',
  'campaign',
  'portal',
  'company',
  'corporate',
  'business',
  'merchant',
  'tenant',
  'country',
  'maker',
  'checker',
  'killer',
  'hunter',
  'ranger',
  'soldier',
  'warrior',
  'legend',
  'gamer',
  'player',
  'nintendo',
  'playstation',
  'minecraft',
  'fortnite',
  'naruto',
  'anime',
  'music',
  'guitar',
  'metallica',
  'nirvana',
  'slipknot',
  'blink',
  'jesus',
  'christ',
  'heaven',
  'angel',
  'satan',
  'cheese',
  'pepper',
  'coffee',
  'chicken',
  'dolphin',
  'mustang',
  'ferrari',
  'porsche',
  'harley',
  'yamaha',
  'honda',
  'toyota',
  'nissan',
  'maggie',
  'bailey',
  'oliver',
  'lucky',
  'shelby',
  'sparky',
  'snoopy',
  'garfield',
  'peanut',
  'butterfly',
  'rainbow',
  'unicorn',
  'trustno1',
  'iloveu',
  'qwerty123',
  'password1',
  'abc123',
  'abcdef',
  'abcdefg',
  'aaaaaa',
  'asdasd',
  'asdfasdf',
  'zaq12wsx',
  'passpass',
  'lol123',
  'hello123',
  'admin123',
  'test123',
  'welcome123',
  'letmein123',
]);

/**
 * Substitutions folded out before the common-password lookup, so `P@ssw0rd` and `l3tm31n`
 * are recognised as the entries they decorate. Ambiguous glyphs are mapped to their most
 * frequent intent (`1` → `i`, `0` → `o`); this is a heuristic hardening layer over the list
 * lookup and is not load-bearing on its own — see {@link COMMON_PASSWORDS}.
 */
export const LEET_SUBSTITUTIONS: Readonly<Record<string, string>> = Object.freeze({
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '9': 'g',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'l',
  '+': 't',
});
