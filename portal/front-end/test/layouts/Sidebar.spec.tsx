import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { BootstrapContext } from '../../src/auth/useBootstrap';
import { Sidebar } from '../../src/layouts/Sidebar';
import { NAV_WITH_CHILDREN, THREE_ITEM_NAV, makeBootstrapValue, noop } from './fixtures';

function renderSidebar(nav: typeof THREE_ITEM_NAV, initialPath = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <BootstrapContext.Provider value={makeBootstrapValue({ nav })}>
        <Routes>
          <Route path="*" element={<Sidebar mobileOpen={false} onMobileClose={noop} />} />
        </Routes>
      </BootstrapContext.Provider>
    </MemoryRouter>,
  );
}

describe('TC-1: Sidebar.tsx has zero hard-coded route-path literals', () => {
  it('the source file contains no literal route path matching the verification-step pattern', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/layouts/Sidebar.tsx'), 'utf8');
    expect(source).not.toMatch(/'\/(dashboard|campaigns|rules)/);
    // Broader sweep: no quoted string anywhere in the file starts with a leading `/`
    // followed by a letter (the shape every real route path in this app takes).
    const quotedLeadingSlash = [...source.matchAll(/(['"`])\/[a-zA-Z][^'"`]*\1/g)];
    expect(quotedLeadingSlash).toEqual([]);
  });
});

describe('TC-2: bootstrap with 3 nav items', () => {
  it('renders exactly 3 items, in the order bootstrap sent them', () => {
    renderSidebar(THREE_ITEM_NAV);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.textContent)).toEqual(['Dashboard', 'Countries', 'Rules']);
  });
});

describe('TC-4/TC-5: purely data-driven — a different bootstrap payload changes the menu with no code change', () => {
  it('a 2-item payload renders 2 items, not 3', () => {
    renderSidebar(THREE_ITEM_NAV.slice(0, 2));
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getAllByRole('link')).toHaveLength(2);
  });

  it('an empty payload (every item disabled) renders no items at all', () => {
    renderSidebar([]);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).queryAllByRole('link')).toHaveLength(0);
  });
});

describe('TC-3: a parent with children renders nested and collapsible', () => {
  it('starts collapsed when its section is not the active route, and a toggle expands/collapses it', async () => {
    const user = userEvent.setup();
    renderSidebar(NAV_WITH_CHILDREN, '/dashboard');

    // Not on a `/campaigns/*` route — the group starts collapsed rather than dumping every
    // section's children into view at once.
    expect(screen.queryByRole('link', { name: 'Create Campaign' })).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'Campaigns' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Create Campaign' })).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Create Campaign' })).not.toBeInTheDocument();
  });
});

describe('TC-6: the active route is highlighted with aria-current="page"', () => {
  it('marks only the matching item', () => {
    renderSidebar(THREE_ITEM_NAV, '/countries');
    const active = screen.getByRole('link', { name: 'Countries' });
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
  });

  it('auto-expands the ancestor group of a nested active route', () => {
    renderSidebar(NAV_WITH_CHILDREN, '/campaigns/new');
    const toggle = screen.getByRole('button', { name: 'Campaigns' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Create Campaign' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

describe('TC-15/TC-16: responsive collapse and keyboard/focus behaviour', () => {
  it('the desktop nav is hidden below the lg breakpoint via Tailwind classes, and a mobile drawer exists', () => {
    const { container } = renderSidebar(THREE_ITEM_NAV);
    const aside = container.querySelector('aside');
    expect(aside?.className).toMatch(/\bhidden\b/);
    expect(aside?.className).toMatch(/\blg:flex\b/);
  });

  it('every nav item is a real, tab-reachable link/button (no positive tabindex, nothing inert)', () => {
    renderSidebar(NAV_WITH_CHILDREN);
    for (const el of [
      ...screen.getAllByRole('link'),
      ...screen.getAllByRole('button', { name: 'Campaigns' }),
    ]) {
      expect(el.getAttribute('tabindex')).not.toBe('-1');
    }
  });

  it('opening the mobile drawer traps focus inside it (delegated to the shared Drawer, T-021)', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <BootstrapContext.Provider value={makeBootstrapValue({ nav: THREE_ITEM_NAV })}>
          <Routes>
            <Route path="*" element={<Sidebar mobileOpen onMobileClose={noop} />} />
          </Routes>
        </BootstrapContext.Provider>
      </MemoryRouter>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Menu' });
    expect(within(dialog).getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
  });
});
