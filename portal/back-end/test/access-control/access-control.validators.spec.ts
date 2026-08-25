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
