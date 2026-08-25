/**
 * T-047 — check 3 of 3: *which slices of the configuration may this certificate read?*
 * (09-INTEGRATION.md §4c, implementation note 10.)
 *
 * ### Sections are an authorisation boundary, not a bandwidth optimisation
 *
 * That sentence is the whole reason `ConfigSection` is a coarse named enum rather than a
 * `google.protobuf.FieldMask`. A reward-delivery service should not merely *choose* to omit rule
 * expressions — it must be **incapable** of retrieving them, and you cannot write or audit a
 * legible grant over `trackers.*.components.*.rules.*.expression`.
 *
 * ### The asymmetry between an explicit and an implicit request
 *
 * | Request | Response |
 * |---|---|
 * | `sections` empty | every **granted** section, `sections_omitted` listing what was withheld |
 * | `sections=[REWARDS]`, granted | `BASIC` + `REWARDS` |
 * | `sections=[RULES]`, **not granted** | `PERMISSION_DENIED` **naming the section** |
 *
 * Deliberate, and the two halves fail in opposite directions on purpose. An **explicit** ask for
 * something ungranted is a misconfiguration on the caller's side and must fail loudly (TC-32); an
 * **implicit** ask — the empty list — is a caller saying *"give me what I may have"*, where
 * silently trimming is correct and `sections_omitted` keeps it honest (TC-31).
 *
 * ### `BASIC` is always included
 *
 * TC-33. A configuration with no campaign header is not interpretable, and returning one invites a
 * null-dereference in every consumer. `GrpcGrantsService` also stores `BASIC` into every grant it
 * writes, so the grant a `super_admin` reads back says what the server will actually do rather
 * than relying on a rule applied invisibly here.
 */
import {
  ALL_SECTIONS,
  ALWAYS_INCLUDED_SECTION,
  CONFIG_SECTION,
  type ConfigSectionName,
} from './grpc.constants';
import { SectionNotGrantedError } from './grpc.errors';

/** What the caller gets, and what was withheld for lack of a grant. */
export interface SectionResolution {
  readonly returned: readonly ConfigSectionName[];
  /** Populated **only** when `sections` was empty — see the proto comment on field 20. */
  readonly omitted: readonly ConfigSectionName[];
}

/** The wire enum number of a section name. */
export function sectionNumber(section: ConfigSectionName): number {
  return CONFIG_SECTION[section];
}

/** The section name of a wire enum number, or `null` for `UNSPECIFIED` and anything unknown. */
export function sectionName(value: number): ConfigSectionName | null {
  const found = ALL_SECTIONS.find((section) => CONFIG_SECTION[section] === value);
  return found ?? null;
}

/**
 * Decides which sections a call returns.
 *
 * `requested` is the raw enum numbers off the wire. An unknown number — a section a newer client
 * knows and this build does not — is treated as **not granted** and therefore refused when asked
 * for explicitly, rather than silently dropped: a client that asked for something it did not
 * receive must be told, or it will act on a config it believes is complete.
 */
export function resolveSections(
  identity: string,
  granted: readonly ConfigSectionName[],
  requested: readonly number[],
): SectionResolution {
  const grantedSet = new Set<ConfigSectionName>(granted);
  grantedSet.add(ALWAYS_INCLUDED_SECTION);

  const explicit = requested.filter((value) => value !== CONFIG_SECTION.CONFIG_SECTION_UNSPECIFIED);

  if (explicit.length === 0) {
    return {
      returned: ALL_SECTIONS.filter((section) => grantedSet.has(section)),
      omitted: ALL_SECTIONS.filter((section) => !grantedSet.has(section)),
    };
  }

  const wanted = new Set<ConfigSectionName>([ALWAYS_INCLUDED_SECTION]);
  for (const value of explicit) {
    const name = sectionName(value);
    if (name === null) {
      throw new SectionNotGrantedError(identity, `CONFIG_SECTION(${value})`);
    }
    if (!grantedSet.has(name)) {
      throw new SectionNotGrantedError(identity, name);
    }
    wanted.add(name);
  }

  return { returned: ALL_SECTIONS.filter((section) => wanted.has(section)), omitted: [] };
}

/** Whether a resolved section set includes `section` — the predicate `ConfigSnapshotBuilder`
 * asks before issuing that section's queries (implementation note 10: *"build only the requested
 * sections; assembling everything and stripping wastes the DB work that motivated the
 * feature"*). */
export function includesSection(
  resolution: SectionResolution,
  section: ConfigSectionName,
): boolean {
  return resolution.returned.includes(section);
}
