/**
 * T-023 — the primary navigation (04-FRONTEND.md §1, §3). Renders `buildNavTree(nav)` and
 * nothing else: **zero hard-coded menu items or route literals** — `Sidebar.tsx` grepped for a
 * route path must return no matches (TC-1), which is exactly why every path drawn here comes
 * from `node.path`, never a string literal in this file.
 *
 * Two renderings of the same tree, not two implementations of it: a persistent `<aside>` from
 * the `lg` breakpoint (1024px, Tailwind's default) up, and the shared `Drawer` component (T-021,
 * already focus-trapped and Escape-to-close — TC-16) below it. `SidebarNav` is the one piece of
 * markup both share.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { Drawer } from '../components/Drawer';
import { cx } from '../components/internal/cx';
import { useBootstrap } from '../auth/useBootstrap';
import { activeAncestorKeys, buildNavTree, type NavTreeNode } from './buildNavTree';

export interface SidebarProps {
  mobileOpen: boolean;
  onMobileClose: () => void;
}

export function Sidebar({ mobileOpen, onMobileClose }: SidebarProps) {
  const { nav } = useBootstrap();
  const tree = useMemo(() => buildNavTree(nav), [nav]);

  return (
    <>
      <aside className="hidden shrink-0 border-r border-slate-200 bg-white lg:flex lg:w-60 lg:flex-col">
        <SidebarNav tree={tree} />
      </aside>
      <Drawer open={mobileOpen} onClose={onMobileClose} title="Menu" side="left" width="sm">
        <SidebarNav tree={tree} onNavigate={onMobileClose} />
      </Drawer>
    </>
  );
}

function SidebarNav({ tree, onNavigate }: { tree: NavTreeNode[]; onNavigate?: () => void }) {
  const location = useLocation();
  const expandedAncestors = useMemo(
    () => activeAncestorKeys(tree, location.pathname),
    [tree, location.pathname],
  );

  return (
    <nav aria-label="Primary" className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
      <NavList
        nodes={tree}
        depth={0}
        expandedAncestors={expandedAncestors}
        onNavigate={onNavigate}
      />
    </nav>
  );
}

function NavList({
  nodes,
  depth,
  expandedAncestors,
  onNavigate,
}: {
  nodes: readonly NavTreeNode[];
  depth: number;
  expandedAncestors: Set<string>;
  onNavigate?: () => void;
}) {
  if (nodes.length === 0) return null;

  return (
    <ul className={cx('flex flex-col gap-0.5', depth > 0 && 'ml-4 border-l border-slate-100 pl-2')}>
      {nodes.map((node) => (
        <li key={node.key}>
          {node.children.length > 0 ? (
            <NavGroup
              node={node}
              depth={depth}
              defaultOpen={expandedAncestors.has(node.key)}
              expandedAncestors={expandedAncestors}
              onNavigate={onNavigate}
            />
          ) : (
            <NavLeaf node={node} onNavigate={onNavigate} />
          )}
        </li>
      ))}
    </ul>
  );
}

function NavLeaf({ node, onNavigate }: { node: NavTreeNode; onNavigate?: () => void }) {
  return (
    <NavLink
      to={node.path}
      end
      onClick={onNavigate}
      className={({ isActive }) =>
        cx(
          'block rounded-control px-3 py-2 text-sm font-medium transition-colors',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500',
          isActive
            ? 'bg-primary-50 text-primary-700'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
        )
      }
    >
      {node.label}
    </NavLink>
  );
}

function NavGroup({
  node,
  depth,
  defaultOpen,
  expandedAncestors,
  onNavigate,
}: {
  node: NavTreeNode;
  depth: number;
  defaultOpen: boolean;
  expandedAncestors: Set<string>;
  onNavigate?: () => void;
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = `nav-group-${node.key}`;

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
        className={cx(
          'flex w-full items-center justify-between rounded-control px-3 py-2 text-sm font-medium text-slate-600',
          'hover:bg-slate-100 hover:text-slate-900',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500',
        )}
      >
        {node.label}
        <ChevronDown
          aria-hidden="true"
          className={cx('size-4 shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div id={panelId}>
          <NavList
            nodes={node.children}
            depth={depth + 1}
            expandedAncestors={expandedAncestors}
            onNavigate={onNavigate}
          />
        </div>
      )}
    </div>
  );
}
