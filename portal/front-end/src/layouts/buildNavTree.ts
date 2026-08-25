/**
 * T-023 — the nav tree `Sidebar` renders (04-FRONTEND.md §1, §3).
 *
 * ### Why this is not literally 04-FRONTEND.md §3's `buildNavTree(nav)` pseudocode
 *
 * §3's snippet reads `nest by parent_nav_key, sorts by sort_order`, describing a client-side
 * fold over a **flat** list. That is not what `GET /me/bootstrap` actually sends: T-015's
 * `BootstrapService.buildNavTree` (`back-end/src/modules/me/bootstrap.service.ts`) already
 * nests by `parent_nav_key` and orders by `sort_order` **server-side**, and drops any orphan
 * transitively (its own header explains why: a disabled parent must not leak its children into
 * the menu as top-level items). `bootstrap.schema.ts`'s `BootstrapNavItem` reflects that choice
 * directly — it is already a tree (`children: readonly BootstrapNavItem[]`), with no
 * `parentNavKey`/`sortOrder` field left for a client to re-derive nesting or order from.
 *
 * AGENT-PROTOCOL.md §3: *"If the task description conflicts with a design doc, the design doc
 * wins; note the conflict in your completion report."* Both the task file and §3's own pseudocode
 * describe client-side nesting, but the shipped `/me/bootstrap` contract (the more specific,
 * more recent artifact — a real, tested `BootstrapService` — 00-ARCHITECTURE.md §7's own JSON
 * sketch shows nav as the thing "React renders nav, routes and dashboard from data") only makes
 * sense read as: the tree-building happened once, on the server, precisely so every client (this
 * SPA today, any other client later) gets the same already-correct tree rather than re-deriving
 * it and risking a second, drifting implementation of the orphan/cycle rules T-015 already had to
 * get right. This file is that reconciliation, flagged here and in the completion report per §3.
 *
 * What is left for the client to own: defensive normalisation (a malformed row — an empty
 * `key`/`path` reaching this far would be a real bug upstream, but "drop it" is a strictly safer
 * failure mode for a menu-rendering function than crashing the whole shell over it) and the
 * small view-model helpers below that `Sidebar` needs and the wire contract has no reason to
 * carry: which nodes are on the "active" chain for a given pathname.
 */
import type { BootstrapNavItem } from '@reward-portal/shared';

export interface NavTreeNode {
  readonly key: string;
  readonly label: string;
  readonly icon: string | null;
  readonly path: string;
  readonly children: readonly NavTreeNode[];
}

/**
 * Normalises `/me/bootstrap`'s `nav` (already role-scoped, already nested, already ordered) into
 * the `NavTreeNode[]` `Sidebar` renders. Order is preserved exactly as received — TC-2/TC-4's
 * "no code change" property only holds if this function never re-sorts what the server already
 * sorted.
 */
export function buildNavTree(nav: readonly BootstrapNavItem[]): NavTreeNode[] {
  return nav.filter(isWellFormed).map(toNode);
}

function isWellFormed(item: BootstrapNavItem): boolean {
  return item.key.trim() !== '' && item.path.trim() !== '';
}

function toNode(item: BootstrapNavItem): NavTreeNode {
  return {
    key: item.key,
    label: item.label,
    icon: item.icon,
    path: item.path,
    children: item.children.filter(isWellFormed).map(toNode),
  };
}

/** Every node, depth-first — used to search the whole tree without writing recursion twice. */
export function flattenNavTree(tree: readonly NavTreeNode[]): NavTreeNode[] {
  const out: NavTreeNode[] = [];
  const walk = (nodes: readonly NavTreeNode[]) => {
    for (const node of nodes) {
      out.push(node);
      if (node.children.length > 0) walk(node.children);
    }
  };
  walk(tree);
  return out;
}

/**
 * The `key`s of every node whose subtree contains a node matching `pathname` exactly, `pathname`
 * included. `Sidebar` uses this to auto-expand the ancestor chain of the current route so the
 * active leaf is never hidden behind a collapsed group on first paint.
 */
export function activeAncestorKeys(tree: readonly NavTreeNode[], pathname: string): Set<string> {
  const ancestors = new Set<string>();

  function containsActive(node: NavTreeNode): boolean {
    const isSelf = node.path === pathname;
    const childHasActive = node.children.some(containsActive);
    if (isSelf || childHasActive) ancestors.add(node.key);
    return isSelf || childHasActive;
  }

  for (const node of tree) containsActive(node);
  return ancestors;
}
