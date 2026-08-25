import { describe, expect, it } from 'vitest';
import type { BootstrapNavItem } from '@reward-portal/shared';
import { activeAncestorKeys, buildNavTree, flattenNavTree } from '../../src/layouts/buildNavTree';

describe('buildNavTree', () => {
  it('preserves the order and shape `/me/bootstrap` already sent (server already sorted/nested)', () => {
    const nav: BootstrapNavItem[] = [
      { key: 'dashboard', label: 'Dashboard', icon: null, path: '/dashboard', children: [] },
      { key: 'countries', label: 'Countries', icon: 'globe', path: '/countries', children: [] },
    ];
    expect(buildNavTree(nav)).toEqual([
      { key: 'dashboard', label: 'Dashboard', icon: null, path: '/dashboard', children: [] },
      { key: 'countries', label: 'Countries', icon: 'globe', path: '/countries', children: [] },
    ]);
  });

  it('keeps nested children intact, recursively', () => {
    const nav: BootstrapNavItem[] = [
      {
        key: 'campaigns',
        label: 'Campaigns',
        icon: null,
        path: '/campaigns',
        children: [
          {
            key: 'campaign_new',
            label: 'Create',
            icon: null,
            path: '/campaigns/new',
            children: [],
          },
        ],
      },
    ];
    const tree = buildNavTree(nav);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toEqual([
      { key: 'campaign_new', label: 'Create', icon: null, path: '/campaigns/new', children: [] },
    ]);
  });

  it('drops a malformed row (empty key or path) rather than rendering a broken menu item', () => {
    const nav: BootstrapNavItem[] = [
      { key: '', label: 'Broken', icon: null, path: '/broken', children: [] },
      { key: 'ok', label: 'OK', icon: null, path: '', children: [] },
      { key: 'good', label: 'Good', icon: null, path: '/good', children: [] },
    ];
    expect(buildNavTree(nav)).toEqual([
      { key: 'good', label: 'Good', icon: null, path: '/good', children: [] },
    ]);
  });

  it('returns an empty tree for an empty nav array (a role with no menu at all)', () => {
    expect(buildNavTree([])).toEqual([]);
  });
});

describe('flattenNavTree', () => {
  it('walks every node depth-first', () => {
    const tree = buildNavTree([
      {
        key: 'campaigns',
        label: 'Campaigns',
        icon: null,
        path: '/campaigns',
        children: [
          {
            key: 'campaign_new',
            label: 'Create',
            icon: null,
            path: '/campaigns/new',
            children: [],
          },
        ],
      },
      { key: 'dashboard', label: 'Dashboard', icon: null, path: '/dashboard', children: [] },
    ]);
    expect(flattenNavTree(tree).map((n) => n.key)).toEqual([
      'campaigns',
      'campaign_new',
      'dashboard',
    ]);
  });
});

describe('activeAncestorKeys', () => {
  it('marks the active leaf and every ancestor group, nothing else', () => {
    const tree = buildNavTree([
      {
        key: 'campaigns',
        label: 'Campaigns',
        icon: null,
        path: '/campaigns',
        children: [
          {
            key: 'campaign_new',
            label: 'Create',
            icon: null,
            path: '/campaigns/new',
            children: [],
          },
        ],
      },
      { key: 'dashboard', label: 'Dashboard', icon: null, path: '/dashboard', children: [] },
    ]);
    expect(activeAncestorKeys(tree, '/campaigns/new')).toEqual(
      new Set(['campaigns', 'campaign_new']),
    );
    expect(activeAncestorKeys(tree, '/dashboard')).toEqual(new Set(['dashboard']));
    expect(activeAncestorKeys(tree, '/nowhere')).toEqual(new Set());
  });
});
