/**
 * T-033 — the `/admin/access-control` wire contract. Same discipline `rule.schema.spec.ts` and
 * `bootstrap.schema.spec.ts` establish: every object is `.strict()`, and `previewResponseSchema`
 * gets the most attention — it is literally `bootstrap.schema.ts`'s own nav/widget/permissions
 * shapes, reused rather than re-declared.
 */
import {
  entityCatalogueEntrySchema,
  navConfigItemSchema,
  navConfigResponseSchema,
  permissionsResponseSchema,
  previewRequestSchema,
  previewResponseSchema,
  putNavConfigRequestSchema,
  putPermissionsRequestSchema,
  putWidgetConfigRequestSchema,
  reorderRequestSchema,
  roleSummarySchema,
  widgetConfigItemSchema,
  widgetConfigResponseSchema,
} from './access-control.schema';

describe('roleSummarySchema', () => {
  it('accepts a role with a user count', () => {
    expect(roleSummarySchema.safeParse({ role: 'maker', userCount: 3 }).success).toBe(true);
  });

  it('rejects an unrecognised role', () => {
    expect(roleSummarySchema.safeParse({ role: 'god_mode', userCount: 0 }).success).toBe(false);
  });

  it('rejects an unexpected key', () => {
    expect(roleSummarySchema.safeParse({ role: 'maker', userCount: 3, extra: true }).success).toBe(
      false,
    );
  });
});

describe('entityCatalogueEntrySchema', () => {
  it('accepts an entry with protected actions', () => {
    expect(
      entityCatalogueEntrySchema.safeParse({
        entity: 'rule',
        actions: ['view', 'create', 'update', 'delete'],
        protectedActions: ['create', 'update', 'delete'],
      }).success,
    ).toBe(true);
  });
});

describe('navConfigItemSchema / navConfigResponseSchema', () => {
  function validItem() {
    return {
      navKey: 'dashboard',
      label: 'Dashboard',
      icon: null,
      path: '/dashboard',
      parentNavKey: null,
      sortOrder: 10,
      enabled: true,
    };
  }

  it('accepts a well-formed item', () => {
    expect(navConfigItemSchema.safeParse(validItem()).success).toBe(true);
  });

  it('accepts a full response', () => {
    expect(
      navConfigResponseSchema.safeParse({ role: 'maker', version: 1, items: [validItem()] })
        .success,
    ).toBe(true);
  });

  it('rejects a missing version', () => {
    expect(navConfigResponseSchema.safeParse({ role: 'maker', items: [] }).success).toBe(false);
  });
});

describe('putNavConfigRequestSchema — implementation note 5 (full replace)', () => {
  it('accepts an empty items array (TC-24)', () => {
    expect(putNavConfigRequestSchema.safeParse({ expectedVersion: 1, items: [] }).success).toBe(
      true,
    );
  });

  it('rejects an upper-case navKey', () => {
    expect(
      putNavConfigRequestSchema.safeParse({
        expectedVersion: 1,
        items: [{ navKey: 'Dashboard', label: 'D', path: '/d', sortOrder: 1, enabled: true }],
      }).success,
    ).toBe(false);
  });

  it('rejects a negative expectedVersion', () => {
    expect(putNavConfigRequestSchema.safeParse({ expectedVersion: -1, items: [] }).success).toBe(
      false,
    );
  });
});

describe('widgetConfigItemSchema / widgetConfigResponseSchema / putWidgetConfigRequestSchema', () => {
  it('accepts a widget with a free-form config', () => {
    expect(
      widgetConfigItemSchema.safeParse({
        widgetKey: 'kpi_my_drafts',
        label: 'My Drafts',
        config: { foo: 'bar' },
        sortOrder: 10,
        enabled: true,
      }).success,
    ).toBe(true);
  });

  it('accepts a full response', () => {
    expect(
      widgetConfigResponseSchema.safeParse({ role: 'maker', version: 1, items: [] }).success,
    ).toBe(true);
  });

  it('rejects an upper-case widgetKey in a PUT request', () => {
    expect(
      putWidgetConfigRequestSchema.safeParse({
        expectedVersion: 1,
        items: [{ widgetKey: 'KPI', label: 'X', sortOrder: 1, enabled: true }],
      }).success,
    ).toBe(false);
  });
});

describe('permissionsResponseSchema / putPermissionsRequestSchema', () => {
  it('accepts a role/version/permissions triple', () => {
    expect(
      permissionsResponseSchema.safeParse({
        role: 'maker',
        version: 1,
        permissions: { campaign: ['view', 'create'] },
      }).success,
    ).toBe(true);
  });

  it('accepts an empty permission map (TC-24 — a role may legitimately have none)', () => {
    expect(
      putPermissionsRequestSchema.safeParse({ expectedVersion: 1, permissions: {} }).success,
    ).toBe(true);
  });
});

describe('reorderRequestSchema — implementation note 7 (single bulk call)', () => {
  it('accepts several rows reordered in one request', () => {
    expect(
      reorderRequestSchema.safeParse({
        expectedVersion: 1,
        order: [
          { key: 'dashboard', sortOrder: 10 },
          { key: 'campaigns', sortOrder: 20 },
        ],
      }).success,
    ).toBe(true);
  });
});

describe('previewRequestSchema / previewResponseSchema — implementation note 6', () => {
  it("accepts a role-only request — previews the role's current, committed config", () => {
    expect(previewRequestSchema.safeParse({ role: 'checker' }).success).toBe(true);
  });

  it('accepts an uncommitted draft of all three sections', () => {
    expect(
      previewRequestSchema.safeParse({
        role: 'merchant',
        nav: [
          {
            navKey: 'dashboard',
            label: 'Dashboard',
            path: '/dashboard',
            sortOrder: 10,
            enabled: true,
          },
        ],
        permissions: { campaign: ['view'] },
        widgets: [
          { widgetKey: 'kpi_active_campaigns', label: 'Active', sortOrder: 10, enabled: true },
        ],
      }).success,
    ).toBe(true);
  });

  it("the response reuses bootstrap.schema.ts's own nav-tree and widget shapes", () => {
    expect(
      previewResponseSchema.safeParse({
        role: 'checker',
        nav: [
          { key: 'dashboard', label: 'Dashboard', icon: null, path: '/dashboard', children: [] },
        ],
        permissions: { approval: ['view'] },
        widgets: [{ key: 'kpi_pending_my_review', label: 'Pending', config: {} }],
      }).success,
    ).toBe(true);
  });
});
