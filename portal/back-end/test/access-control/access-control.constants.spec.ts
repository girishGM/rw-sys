import {
  ENTITY_ACTION_CATALOGUE,
  GRANTABLE_ENTITIES,
  NON_SUPER_ADMIN_ROLES,
  PROTECTED_PERMISSIONS,
  REQUIRED_SUPER_ADMIN_ACCESS_CONTROL_ACTIONS,
  isProtectedPermission,
} from '@/modules/access-control/access-control.constants';
import { ROLE_ENTITY_PERMISSIONS } from '@/database/migrations/T004_001_seed_role_entity_permissions';
import { DEFINITION_REQUEST_PERMISSIONS } from '@/database/migrations/T042_001_seed_definition_request_permissions';
import { GRPC_GRANT_PERMISSIONS } from '@/database/migrations/T047_002_seed_grpc_grant_permissions';

describe('ENTITY_ACTION_CATALOGUE — 01-DATABASE.md §5.1', () => {
  it('matches the seeded entity list exactly', () => {
    expect([...GRANTABLE_ENTITIES].sort()).toEqual(
      [
        'country',
        'tenant',
        'user',
        'merchant',
        'rule',
        'reward',
        'tenant_budget_ceiling',
        'rule_assignment',
        'reward_assignment',
        'campaign',
        'approval',
        'access_control',
        'grpc_grant',
        'audit',
        'notification',
        'definition_request',
      ].sort(),
    );
  });

  it('access_control offers view/create/update/delete — the four actions super_admin needs to run this screen', () => {
    expect(ENTITY_ACTION_CATALOGUE['access_control']).toEqual([
      'view',
      'create',
      'update',
      'delete',
    ]);
  });

  it('campaign includes pause/resume (T-062 regression)', () => {
    // `PUT /admin/access-control/permissions/:role` is a full replace (implementation note 5):
    // every save resubmits the role's *entire* current permission matrix, not just the touched
    // cell. `T047_003_campaign_pause_permissions.ts` grants `tenant_admin` these two actions
    // directly against `role_entity_permissions`; if this catalogue does not also know about
    // them, `isPermissionsMatrix` 400s the whole payload on every ordinary Save for that role —
    // T-062's actual root cause, not a hand-built or malformed request.
    expect(ENTITY_ACTION_CATALOGUE['campaign']).toEqual(
      expect.arrayContaining(['pause', 'resume']),
    );
  });

  it(
    'covers every {entity, action} any seed migration actually grants (T-062 regression) — ' +
      'a full-replace PUT can only ever 400 on a *malformed* payload, never on a legitimately ' +
      'seeded one',
    () => {
      const seeded = [
        ...ROLE_ENTITY_PERMISSIONS,
        ...DEFINITION_REQUEST_PERMISSIONS,
        ...GRPC_GRANT_PERMISSIONS,
        // `T047_003_campaign_pause_permissions.ts` rewrites `tenant_admin`'s `campaign` row in
        // place rather than seeding a new one, so it has no exported permission-row list of its
        // own to spread here — its grant is restated literally instead (mirrors that migration's
        // own `AFTER` constant, and TC-9/TC-24's own precedent of asserting the *outcome* rather
        // than re-importing the migration's private state).
        { role: 'tenant_admin', entity: 'campaign', actions: ['view', 'pause', 'resume'] },
      ];

      const unknown: { role: string; entity: string; action: string }[] = [];
      for (const row of seeded) {
        const allowed = ENTITY_ACTION_CATALOGUE[row.entity];
        for (const action of row.actions) {
          if (allowed === undefined || !allowed.includes(action)) {
            unknown.push({ role: row.role, entity: row.entity, action });
          }
        }
      }

      expect(unknown).toEqual([]);
    },
  );
});

describe('isProtectedPermission — implementation note 3', () => {
  it('is true for exactly the six rule/reward authoring cells', () => {
    expect(PROTECTED_PERMISSIONS).toHaveLength(6);
    for (const cell of PROTECTED_PERMISSIONS) {
      expect(isProtectedPermission(cell.entity, cell.action)).toBe(true);
    }
  });

  it('is false for rule:view/reward:view — read access is not protected', () => {
    expect(isProtectedPermission('rule', 'view')).toBe(false);
    expect(isProtectedPermission('reward', 'view')).toBe(false);
  });

  it('is false for an unrelated entity', () => {
    expect(isProtectedPermission('campaign', 'create')).toBe(false);
  });
});

describe('REQUIRED_SUPER_ADMIN_ACCESS_CONTROL_ACTIONS — implementation note 2 bullet 1', () => {
  it('is exactly view and update', () => {
    expect([...REQUIRED_SUPER_ADMIN_ACCESS_CONTROL_ACTIONS].sort()).toEqual(['update', 'view']);
  });
});

describe('NON_SUPER_ADMIN_ROLES', () => {
  it('is every role except super_admin', () => {
    expect(NON_SUPER_ADMIN_ROLES).not.toContain('super_admin');
    expect(NON_SUPER_ADMIN_ROLES).toHaveLength(5);
  });
});
