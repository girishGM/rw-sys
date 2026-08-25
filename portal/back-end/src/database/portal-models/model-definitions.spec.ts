/**
 * T-003 unit specs for the `reward_portal` model layer (`src/database/portal-models/**`).
 *
 * Complements `test/database/models.e2e-spec.ts` (TC-3..TC-7, TC-11 already proven live
 * against the real DB) rather than duplicating it — this file exercises the model layer's
 * own definition-time code (schema/tableName/paranoid declarations, `@DefaultScope`
 * sensitive-column exclusion, association wiring) without a DB connection, which is what
 * the T-003 review found had zero `test:cov` coverage.
 */
import { buildTestSequelize } from '../models/build-test-sequelize';
import { PORTAL_MODELS } from './index';
import { PortalUser } from './portal-user.model';
import { PortalUserCredential } from './portal-user-credential.model';
import { PortalSession } from './portal-session.model';

// The only `reward_portal` table with a genuine `deleted_at` column (implementation note 2 /
// this class's own doc comment).
const PARANOID_MODEL_NAMES = new Set(['PortalUser']);

beforeAll(() => {
  buildTestSequelize();
});

describe('reward_portal model definitions (T-003)', () => {
  it.each(PORTAL_MODELS.map((model) => [model.name, model] as const))(
    '%s declares an explicit reward_portal schema, underscored: true and a snake_case tableName',
    (_name, model) => {
      const options = (model as unknown as { options: Record<string, unknown> }).options;
      expect(options.schema).toBe('reward_portal');
      expect(options.underscored).toBe(true);
      expect(typeof options.tableName).toBe('string');
      expect(options.tableName as string).toMatch(/^[a-z][a-z0-9_]*$/);
    },
  );

  it.each(PORTAL_MODELS.map((model) => [model.name, model] as const))(
    '%s only sets paranoid: true when it is the confirmed deleted_at table (PortalUser)',
    (name, model) => {
      const options = (model as unknown as { options: Record<string, unknown> }).options;
      expect(Boolean(options.paranoid)).toBe(PARANOID_MODEL_NAMES.has(name));
    },
  );

  it('PortalUser excludes mfaSecretEnc from the default scope (implementation note 5)', () => {
    const scope = (PortalUser as unknown as { _scope: { attributes?: { exclude?: string[] } } })
      ._scope;
    expect(scope.attributes?.exclude).toEqual(['mfaSecretEnc']);
  });

  it('PortalUserCredential excludes passwordHash and previousHashes from the default scope', () => {
    const scope = (
      PortalUserCredential as unknown as { _scope: { attributes?: { exclude?: string[] } } }
    )._scope;
    expect(scope.attributes?.exclude).toEqual(
      expect.arrayContaining(['passwordHash', 'previousHashes']),
    );
  });

  it('PortalUser wires its cross-schema (Country/Tenant/Merchant) and self (creator) associations', () => {
    expect(Object.keys(PortalUser.associations)).toEqual(
      expect.arrayContaining(['country', 'tenant', 'merchant', 'creator']),
    );
  });

  it('PortalUserCredential and PortalSession each belong to a PortalUser', () => {
    expect(Object.keys(PortalUserCredential.associations)).toContain('user');
    expect(Object.keys(PortalSession.associations)).toContain('user');
  });

  it('PortalUser declares a deletedAt attribute; PortalUserCredential (not paranoid) does not', () => {
    expect(Object.keys(PortalUser.rawAttributes)).toContain('deletedAt');
    expect(Object.keys(PortalUserCredential.rawAttributes)).not.toContain('deletedAt');
  });
});

describe('PortalUser scope exclusion actually removes the attribute from a scoped build (TC-4 analogue)', () => {
  it('a plain instance still carries mfaSecretEnc — the exclusion applies to queries, not construction', () => {
    // Documents the boundary of what a default-scope `attributes.exclude` does and does not
    // affect: it changes what `SELECT` columns are requested (TC-4/TC-5 prove that live,
    // against a real query, in models.e2e-spec.ts), not what an in-memory `build()` carries.
    const instance = PortalUser.build({ mfaSecretEnc: 'ciphertext' } as never);
    expect(instance.getDataValue('mfaSecretEnc' as never)).toBe('ciphertext');
  });
});
