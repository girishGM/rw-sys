/**
 * T-047 — `config_hash` (TC-29, §11) and the ETag/section trap (TC-34, §4c).
 *
 * §4c calls the ETag bug *"the one this design is most likely to ship with"*, and the task file
 * repeats it: a client that cached a `BASIC`-only response and later asks for everything must not
 * be told `not_modified`. It is asserted here at the unit level and again over a real socket in
 * `grpc.e2e-spec.ts`; both, because this is the failure the task file singles out.
 */
import { canonicalJson, configHashOf, etagOf } from '@/grpc/config-hash';

describe('config_hash (TC-29, §11 shadow traffic)', () => {
  it('is identical for identical config across calls', () => {
    const payload = { campaignId: 1, rules: [{ ruleId: 2, versionNo: 3 }] };
    expect(configHashOf(payload)).toBe(configHashOf({ ...payload }));
  });

  it('is identical when keys were built in a different order', () => {
    // The property §11's divergence logging depends on: two sources building the same document
    // must agree, and object key order follows construction rather than meaning.
    const a = { campaignId: 1, status: 'active', tenantId: 7 };
    const b = { tenantId: 7, campaignId: 1, status: 'active' };
    expect(configHashOf(a)).toBe(configHashOf(b));
  });

  it('changes when any value changes', () => {
    const base = configHashOf({ campaignId: 1, status: 'active' });
    expect(configHashOf({ campaignId: 1, status: 'paused' })).not.toBe(base);
    expect(configHashOf({ campaignId: 2, status: 'active' })).not.toBe(base);
  });

  it('respects array order, which is meaningful here (sequence_order, binding id)', () => {
    expect(configHashOf({ trackers: [1, 2] })).not.toBe(configHashOf({ trackers: [2, 1] }));
  });

  it('treats an absent key and an explicitly-undefined one as the same document', () => {
    expect(configHashOf({ a: 1, b: undefined })).toBe(configHashOf({ a: 1 }));
  });

  it('canonicalises the scalar edges — null, undefined at the root, and a bare primitive', () => {
    // `canonicalise` is recursive and its leaf branch has to answer for every JSON type; a payload
    // whose only difference is `null` vs `undefined` must not change the hash, or §11's divergence
    // log fills with noise the first time an optional column comes back empty.
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('MYR')).toBe('"MYR"');
    expect(canonicalJson([undefined, 1])).toBe('[null,1]');
  });

  it('canonicalises nested structures and dates deterministically', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
    expect(canonicalJson({ at: new Date('2026-01-01T00:00:00.000Z') })).toBe(
      '{"at":"2026-01-01T00:00:00.000Z"}',
    );
  });
});

describe('etag covers the section set — TC-34, the bug §4c predicts', () => {
  const hash = configHashOf({ campaignId: 1 });

  it('differs between a BASIC-only response and a full one', () => {
    const basic = etagOf(hash, ['BASIC']);
    const everything = etagOf(hash, ['BASIC', 'MERCHANTS', 'TRACKERS', 'RULES', 'REWARDS', 'CAPS']);
    expect(basic).not.toBe(everything);
  });

  it('is stable regardless of the order the sections were resolved in', () => {
    expect(etagOf(hash, ['REWARDS', 'BASIC'])).toBe(etagOf(hash, ['BASIC', 'REWARDS']));
  });

  it('changes when the config changes even if the sections do not', () => {
    expect(etagOf(configHashOf({ campaignId: 2 }), ['BASIC'])).not.toBe(etagOf(hash, ['BASIC']));
  });

  it('is not simply the config hash — omitting the sections is the whole trap', () => {
    expect(etagOf(hash, ['BASIC'])).not.toBe(hash);
  });
});
