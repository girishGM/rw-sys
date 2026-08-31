import {
  isPermissionsMatrix,
  isWidgetConfig,
} from '@/modules/access-control/access-control.validators';

describe('isPermissionsMatrix', () => {
  it('accepts an empty object', () => {
    expect(isPermissionsMatrix({})).toBe(true);
  });

  it('accepts a valid entity/action map', () => {
    expect(isPermissionsMatrix({ campaign: ['view', 'create'], user: ['view'] })).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(isPermissionsMatrix('nope')).toBe(false);
    expect(isPermissionsMatrix(null)).toBe(false);
    expect(isPermissionsMatrix(42)).toBe(false);
  });

  it('rejects an array', () => {
    expect(isPermissionsMatrix([])).toBe(false);
  });

  it('rejects an unknown entity', () => {
    expect(isPermissionsMatrix({ not_real: ['view'] })).toBe(false);
  });

  it('rejects a known entity with an unknown action', () => {
    expect(isPermissionsMatrix({ audit: ['delete'] })).toBe(false);
  });

  it('rejects a non-array action list', () => {
    expect(isPermissionsMatrix({ campaign: 'view' })).toBe(false);
  });

  it('rejects a non-string action', () => {
    expect(isPermissionsMatrix({ campaign: [1] })).toBe(false);
  });

  // T-140 regression: `rule_category`, `rule_sub_category`, `reward_category`,
  // `reward_sub_category`, `field_context_provider`, `field_api_lookup_provider` and
  // `tenant_currency` are all seeded into `role_entity_permissions` (T106_001/T116_002/
  // T121_002/T126_002) but were absent from `ENTITY_ACTION_CATALOGUE`, so a matrix containing any
  // of them — including one `GET /permissions/:role` itself would have just returned — was
  // rejected here, 400ing every ordinary Save for every role (all 6 hold at least `view` on all
  // 7). This is the real client (`isPermissionsMatrix`, exactly what the DTO decorator and the
  // PUT controller call) exercising the actual bug, not a restatement of the catalogue constant.
  it('accepts a matrix containing each of the 7 entities T-140 found missing from the catalogue', () => {
    expect(
      isPermissionsMatrix({
        rule_category: ['view', 'create', 'update'],
        rule_sub_category: ['view'],
        reward_category: ['view', 'create', 'update'],
        reward_sub_category: ['view'],
        field_context_provider: ['view', 'create', 'update'],
        field_api_lookup_provider: ['view'],
        tenant_currency: ['view', 'create', 'update'],
      }),
    ).toBe(true);
  });
});

describe('isWidgetConfig', () => {
  it('accepts undefined (optional field)', () => {
    expect(isWidgetConfig(undefined)).toBe(true);
  });

  it('accepts a plain object', () => {
    expect(isWidgetConfig({ chartType: 'bar' })).toBe(true);
  });

  it('rejects null', () => {
    expect(isWidgetConfig(null)).toBe(false);
  });

  it('rejects an array', () => {
    expect(isWidgetConfig([1, 2])).toBe(false);
  });

  it('rejects a primitive', () => {
    expect(isWidgetConfig('nope')).toBe(false);
  });
});
