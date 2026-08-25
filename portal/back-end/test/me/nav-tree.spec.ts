/**
 * T-015 — `buildNavTree`, the function TC-8 is about.
 *
 * > *"An orphan child (parent missing or disabled) must be dropped, not promoted to top level —
 * > otherwise disabling a parent leaks its children into the menu."*
 *
 * The task file names TC-8 as one of the two failure modes this endpoint is most likely to ship
 * with, and the reason it is easy to ship is that the naive implementation — group by
 * `parent_nav_key`, then append anything whose parent was not found to the root list — is both
 * shorter and *nearly* right. It produces the correct menu for every row in the shipped seed
 * (01-DATABASE.md §5.2 has no parented rows at all) and only misbehaves once a Super Admin uses
 * the feature the column exists for.
 *
 * So this suite tests the shape of the tree, and then tests the four inputs a real
 * `role_nav_configs` table can hold that the naive version gets wrong: a disabled parent, a
 * missing parent, a two-level orphan, and a cycle.
 */
import { buildNavTree, type NavSource } from '@/modules/me/bootstrap.service';

/** A row as it arrives from the service: already filtered to `enabled` and already sorted. */
function row(key: string, parentKey: string | null = null): NavSource {
  return { key, label: key.toUpperCase(), icon: null, path: `/${key}`, parentKey };
}

describe('buildNavTree', () => {
  describe('the flat case — the shipped seed', () => {
    it('returns every row as a root, in the order given', () => {
      const tree = buildNavTree([row('dashboard'), row('countries'), row('rules')]);

      expect(tree.map((item) => item.key)).toEqual(['dashboard', 'countries', 'rules']);
      expect(tree.every((item) => item.children.length === 0)).toBe(true);
    });

    it('carries label, icon and path through unchanged', () => {
      const tree = buildNavTree([
        { key: 'audit', label: 'Audit Log', icon: 'scroll', path: '/audit', parentKey: null },
      ]);

      expect(tree).toEqual([
        { key: 'audit', label: 'Audit Log', icon: 'scroll', path: '/audit', children: [] },
      ]);
    });

    it('returns an empty array for no rows, rather than throwing', () => {
      expect(buildNavTree([])).toEqual([]);
    });
  });

  describe('nesting', () => {
    it('nests a child under its parent and keeps it out of the root list', () => {
      const tree = buildNavTree([row('admin'), row('access_control', 'admin')]);

      expect(tree.map((item) => item.key)).toEqual(['admin']);
      expect(tree[0].children.map((item) => item.key)).toEqual(['access_control']);
    });

    it('preserves sibling order within a parent', () => {
      const tree = buildNavTree([
        row('admin'),
        row('access_control', 'admin'),
        row('grpc_grants', 'admin'),
      ]);

      expect(tree[0].children.map((item) => item.key)).toEqual(['access_control', 'grpc_grants']);
    });

    it('nests a child that sorts *before* its parent — one pass, either order', () => {
      // `sort_order` is set by a Super Admin through T-033 and is not required to place a parent
      // before its children. A two-pass implementation would have to be careful here; the
      // get-or-create bucket makes it a non-event, and this is the test that says so.
      const tree = buildNavTree([row('access_control', 'admin'), row('admin')]);

      expect(tree.map((item) => item.key)).toEqual(['admin']);
      expect(tree[0].children.map((item) => item.key)).toEqual(['access_control']);
    });

    it('nests three levels deep', () => {
      const tree = buildNavTree([row('a'), row('b', 'a'), row('c', 'b')]);

      expect(tree[0].children[0].children.map((item) => item.key)).toEqual(['c']);
    });
  });

  describe('TC-8 — an orphan is dropped, never promoted', () => {
    it('drops a child whose parent is absent (disabled, or never existed)', () => {
      // The service only passes `enabled = true` rows, so "the parent was disabled" and "the
      // parent key is a typo" are the same input here — and must have the same outcome.
      const tree = buildNavTree([row('dashboard'), row('access_control', 'admin')]);

      expect(tree.map((item) => item.key)).toEqual(['dashboard']);
      expect(JSON.stringify(tree)).not.toContain('access_control');
    });

    it('drops the whole subtree when a *grandparent* is disabled', () => {
      // The one-level check passes this input: `c`'s parent `b` is present. Dropping `c` as well
      // requires the check to be transitive, which is the half a naive fix leaves out.
      const tree = buildNavTree([row('b', 'a'), row('c', 'b'), row('keep')]);

      expect(tree.map((item) => item.key)).toEqual(['keep']);
      expect(JSON.stringify(tree)).not.toContain('"b"');
      expect(JSON.stringify(tree)).not.toContain('"c"');
    });

    it('drops a parent and its children together — the verification-step-3 shape', () => {
      const withParent = buildNavTree([row('admin'), row('access_control', 'admin')]);
      const parentDisabled = buildNavTree([row('access_control', 'admin')]);

      expect(withParent).toHaveLength(1);
      expect(parentDisabled).toEqual([]);
    });
  });

  describe('degenerate configurations that must not hang the request', () => {
    it('drops a row that is its own parent', () => {
      const tree = buildNavTree([row('loop', 'loop'), row('ok')]);

      expect(tree.map((item) => item.key)).toEqual(['ok']);
    });

    it('drops a cycle spanning several rows', () => {
      const tree = buildNavTree([row('a', 'c'), row('b', 'a'), row('c', 'b'), row('ok')]);

      expect(tree.map((item) => item.key)).toEqual(['ok']);
    });

    it('keeps the first row when two share a nav_key, rather than forking the tree', () => {
      // `uq_role_nav_configs_role_key` makes this impossible against the real schema; the
      // behaviour is pinned so that if the constraint were ever dropped the menu degrades to
      // "first wins" instead of rendering two nodes with the same identity.
      const tree = buildNavTree([
        { key: 'dup', label: 'First', icon: null, path: '/first', parentKey: null },
        { key: 'dup', label: 'Second', icon: null, path: '/second', parentKey: null },
      ]);

      expect(tree).toHaveLength(1);
      expect(tree[0].label).toBe('First');
    });
  });

  describe('memoisation is an optimisation, not a behaviour', () => {
    it('gives the same answer for many children of one deep chain', () => {
      const rows = [row('a'), row('b', 'a'), row('c', 'b')];
      for (let index = 0; index < 20; index += 1) rows.push(row(`leaf${index}`, 'c'));

      const tree = buildNavTree(rows);

      expect(tree[0].children[0].children[0].children).toHaveLength(20);
    });

    it('gives the same answer for many children of one broken chain', () => {
      const rows = [row('b', 'missing')];
      for (let index = 0; index < 20; index += 1) rows.push(row(`leaf${index}`, 'b'));

      expect(buildNavTree(rows)).toEqual([]);
    });
  });
});
