/**
 * T-020 — the route table and guard chain (04-FRONTEND.md §2).
 *
 * The table below is `04-FRONTEND.md §2`'s route table, translated one line at a time
 * (implementation note 1: "Route table exactly per 04-FRONTEND §2"). Access is expressed as
 * an `entity`/`action` pair rather than a literal role name, because that is the actual
 * enforcement mechanism implementation note 5 specifies (`<RequirePermission entity
 * action>`) and the one the server enforces too (01-DATABASE.md §5.1's
 * `role_entity_permissions` seed) — a role name hard-coded here would drift from that table
 * the moment Super Admin edits the Access Control screen (T-033).
 *
 * Every screen behind a guard is a placeholder (`RouteStub`) — building the real ones is
 * explicitly out of this task's scope ("Out: design system (T-021), API client internals
 * (T-022), the shell chrome (T-023)" plus every Wave 3 feature task). What this task owns is
 * the *shape* of the route tree and the fact that nothing in it is reachable without
 * clearing the guard chain — TC-4 drives that directly off `PROTECTED_ROUTE_SPECS` so a
 * route a future task adds here is automatically covered without editing the test.
 *
 * `buildRouteObjects()` is exported (not just the built `router`) so tests can feed the same
 * table into `createMemoryRouter` instead of `createBrowserRouter`.
 *
 * **T-083** — every screen behind `ProtectedLayout` is now loaded via `React.lazy`/dynamic
 * `import()` (see `lazyPage` below) rather than a top-level static import. Before this fix,
 * every one of Wave 3's feature pages — Countries, Rules, Rewards, Access Control, Tenants,
 * Users, Merchants, Campaigns, Approvals, Definition Requests, the AI agent chat, and every
 * chart they render — was pulled into the one JS asset the whole SPA shipped as (`npm run
 * build` produced exactly one `dist/assets/index-*.js` with no per-route chunks at all). T-053
 * TC-13/TC-14 require the Access Control screen and every chart-bearing route to load as
 * separate chunks, not in the initial bundle; that is only possible if `router.tsx` itself
 * stops importing them eagerly.
 */
import { lazy, Suspense, type ComponentType } from 'react';
import { createBrowserRouter, Navigate, Outlet, type RouteObject } from 'react-router-dom';
import { RequirePermission } from '../auth/RequirePermission';
import { Forbidden } from '../pages/Forbidden';
import { NotFound } from '../pages/NotFound';
// T-024 — the four real auth screens, replacing T-020's `LoginPlaceholder`/`PublicPlaceholder`
// outright (see `routeStubs.tsx`'s own comment for what remains there). `/change-password` is
// deliberately **not** one of `PROTECTED_ROUTE_SPECS` below — see `ChangePasswordPage.tsx`'s
// file banner for why it needs its own top-level route rather than the ordinary
// `ProtectedLayout` guard chain.
// T-060 — `MfaChallengePage` joins them as a fifth top-level, pathless-layout-free auth screen
// (`/mfa-challenge`), for the same reason `/login` itself is one: its only credential is a
// cookie (`__Host-rs_mfa`, half-authenticated at that), never a real session, so it cannot sit
// behind `ProtectedLayout`'s guard chain either. See `MfaChallengePage.tsx`'s own file banner.
//
// T-083 — unlike every feature page below, these five stay statically imported: they are
// needed before a session (or, for `/change-password`, a full one) exists at all, so there is
// no later moment to defer them to, and none is large enough on its own to be worth its own
// chunk.
import {
  ChangePasswordPage,
  ForgotPasswordPage,
  LoginPage,
  MfaChallengePage,
  ResetPasswordPage,
} from '../features/auth';
import { ProtectedLayout, RouteChunkFallback, RouteStub } from './routeStubs';

/**
 * T-083 — adapts `React.lazy`'s requirement for a `default` export onto this codebase's actual
 * convention: every feature module below exports its page components by name, never as a
 * `default`. This changes no feature module's own exports; it only bridges the shape at the
 * one place (this file) that needs a `default`.
 */
function lazyPage<K extends string>(load: () => Promise<Record<K, ComponentType>>, exportName: K) {
  return lazy(async () => ({ default: (await load())[exportName] }));
}

// T-045 — `TraceViewerPage` replaces the generic `RouteStub` for `/trace/:correlationId`, the one
// deviation `buildProtectedChild` below makes from "every screen is a placeholder" (T-020's own
// header). See that function's comment for why.
const TraceViewerPage = lazyPage(() => import('../features/trace'), 'TraceViewerPage');
// T-023 — `DashboardPage` replaces the generic `RouteStub` for `/dashboard`, the same kind of
// deviation T-045 made for `/trace/:correlationId`: this screen is this task's own scope
// (`front-end/src/features/dashboard/**`), so building it behind a stub only to immediately
// swap it out in the same task would be pure churn.
const DashboardPage = lazyPage(
  () => import('../features/dashboard/DashboardPage'),
  'DashboardPage',
);
// T-030 — `CountriesListPage`/`CountryDetailPage` replace the generic `RouteStub` for
// `/countries` and `/countries/:id`, the same kind of deviation T-045/T-023 made: these screens
// are this task's own scope (`front-end/src/features/countries/**`), so building them behind a
// stub only to immediately swap it out in the same task would be pure churn.
const CountriesListPage = lazyPage(() => import('../features/countries'), 'CountriesListPage');
const CountryDetailPage = lazyPage(() => import('../features/countries'), 'CountryDetailPage');
// T-040 — `AuditViewerPage` replaces the generic `RouteStub` for `/audit`, the same kind of
// deviation T-045/T-023/T-030 made: this screen is this task's own scope
// (`front-end/src/features/audit/**`), so building it behind a stub only to immediately swap
// it out in the same task would be pure churn.
const AuditViewerPage = lazyPage(
  () => import('../features/audit/AuditViewerPage'),
  'AuditViewerPage',
);
// T-031 — `RulesListPage`/`RuleDetailPage` replace the generic `RouteStub` for `/rules` and
// `/rules/:id`, the same kind of deviation T-045/T-023/T-030/T-040 made: these screens are this
// task's own scope (`front-end/src/features/rules/**`), so building them behind a stub only to
// immediately swap it out in the same task would be pure churn.
const RulesListPage = lazyPage(() => import('../features/rules'), 'RulesListPage');
const RuleDetailPage = lazyPage(() => import('../features/rules'), 'RuleDetailPage');
// T-032 — `RewardsListPage`/`RewardDetailPage` replace the generic `RouteStub` for `/rewards`
// and `/rewards/:id`, the same kind of deviation T-031/T-045/T-023/T-030/T-040 made: these
// screens are this task's own scope (`front-end/src/features/rewards/**`), so building them
// behind a stub only to immediately swap it out in the same task would be pure churn.
const RewardsListPage = lazyPage(() => import('../features/rewards'), 'RewardsListPage');
const RewardDetailPage = lazyPage(() => import('../features/rewards'), 'RewardDetailPage');
// T-033 — `AccessControlPage` replaces the generic `RouteStub` for `/admin/access-control`, the
// same kind of deviation T-031/T-032/T-045/T-023/T-030/T-040 made: this screen is this task's own
// scope (`front-end/src/features/access-control/**`), so building it behind a stub only to
// immediately swap it out in the same task would be pure churn.
const AccessControlPage = lazyPage(() => import('../features/access-control'), 'AccessControlPage');
// T-034 — `TenantsListPage`/`TenantDetailPage` replace the generic `RouteStub` for `/tenants` and
// `/tenants/:id`, the same kind of deviation every task above made: these screens are this task's
// own scope (`front-end/src/features/tenants/**`), so building them behind a stub only to
// immediately swap it out in the same task would be pure churn.
const TenantsListPage = lazyPage(() => import('../features/tenants'), 'TenantsListPage');
const TenantDetailPage = lazyPage(() => import('../features/tenants'), 'TenantDetailPage');
// T-035 — `UsersListPage`/`UserDetailPage` replace the generic `RouteStub` for `/users` and
// `/users/:id`, the same kind of deviation every task above made: these screens are this task's
// own scope (`front-end/src/features/users/**`), so building them behind a stub only to
// immediately swap it out in the same task would be pure churn.
const UsersListPage = lazyPage(() => import('../features/users'), 'UsersListPage');
const UserDetailPage = lazyPage(() => import('../features/users'), 'UserDetailPage');
// T-036 — `MerchantsListPage`/`MerchantDetailPage` replace the generic `RouteStub` for
// `/merchants` and `/merchants/:id`, the same kind of deviation every task above made: these
// screens are this task's own scope (`front-end/src/features/merchants/**`), so building them
// behind a stub only to immediately swap it out in the same task would be pure churn.
const MerchantsListPage = lazyPage(() => import('../features/merchants'), 'MerchantsListPage');
const MerchantDetailPage = lazyPage(() => import('../features/merchants'), 'MerchantDetailPage');
// T-041 — `BlastHistoryPage` replaces the generic `RouteStub` for `/blasts`, the same kind of
// deviation every task above made: this screen is this task's own scope
// (`front-end/src/features/blasts/**`), so building it behind a stub only to immediately swap
// it out in the same task would be pure churn. No `entity`/`action` in its own
// `PROTECTED_ROUTE_SPECS` row below — see `BlastHistoryPage.tsx`'s own header for why (no
// `role_entity_permissions` row for a `blast` entity exists, the same reason
// `/trace/:correlationId` has none either).
const BlastHistoryPage = lazyPage(() => import('../features/blasts'), 'BlastHistoryPage');
// T-037 — `CampaignsListPage`/`CampaignWizardPage`/`CampaignDetailPage` replace the generic
// `RouteStub` for `/campaigns`, `/campaigns/new` and `/campaigns/:id`, the same kind of deviation
// every task above made: these screens are this task's own scope
// (`front-end/src/features/campaigns/**`), so building them behind a stub only to immediately
// swap them out in the same task would be pure churn. `/campaigns/new/journey` keeps its stub —
// the journey builder is **step 3 of the wizard**, not a separate route, and giving it its own
// URL would let a maker reach it with no campaign to attach a tracker to.
const CampaignsListPage = lazyPage(() => import('../features/campaigns'), 'CampaignsListPage');
const CampaignDetailPage = lazyPage(() => import('../features/campaigns'), 'CampaignDetailPage');
const CampaignWizardPage = lazyPage(() => import('../features/campaigns'), 'CampaignWizardPage');
// T-049 — `AgentChatPage` is a **new** row in `PROTECTED_ROUTE_SPECS` (`/campaigns/assistant`,
// architecture.html §14's own URL), not a stub replacement: no earlier task listed this route.
// It is guarded by `campaign`/`create`, the same pair `/campaigns/new` uses and the same pair
// `agent.controller.ts` enforces server-side (`@RequirePermission(CAMPAIGN_ENTITY, 'create')`), so
// a checker — who has `campaign:view` but not `campaign:create` — gets the Forbidden page here and
// a 403 there (T-049 TC-20). The static segment out-ranks `/campaigns/:id` in React Router's own
// ranking, so `assistant` is never read as a campaign id.
const AgentChatPage = lazyPage(() => import('../features/campaign-agent'), 'AgentChatPage');
// T-038 — `ApprovalsQueuePage`/`ApprovalDetailPage` replace the generic `RouteStub` for
// `/approvals` and `/approvals/:id`, the same kind of deviation every task above made: these
// screens are this task's own scope (`front-end/src/features/approvals/**`), so building them
// behind a stub only to immediately swap it out in the same task would be pure churn. Their
// `entity`/`action` rows below are untouched — `approval`/`view` was already correct, and the
// per-decision permissions (`approval:approve`, `approval:reject`, `campaign:return`) are
// route-level concerns on the server, not route-guard concerns here.
const ApprovalsQueuePage = lazyPage(() => import('../features/approvals'), 'ApprovalsQueuePage');
const ApprovalDetailPage = lazyPage(() => import('../features/approvals'), 'ApprovalDetailPage');
// T-042 — `DefinitionRequestsListPage`/`DefinitionRequestDetailPage` replace the generic
// `RouteStub` for `/definition-requests` and `/definition-requests/:id`, the same kind of
// deviation every task above made: these screens are this task's own scope
// (`front-end/src/features/definition-requests/**`), so building them behind a stub only to
// immediately swap it out in the same task would be pure churn.
const DefinitionRequestsListPage = lazyPage(
  () => import('../features/definition-requests'),
  'DefinitionRequestsListPage',
);
const DefinitionRequestDetailPage = lazyPage(
  () => import('../features/definition-requests'),
  'DefinitionRequestDetailPage',
);
// T-039 — `MerchantCampaignsPage` replaces the generic `RouteStub` for `/merchant/campaigns`, the
// same kind of deviation every task above made: this screen is this task's own scope
// (`front-end/src/features/merchant/**`), so building it behind a stub only to immediately swap
// it out in the same task would be pure churn. No `/merchant/campaigns/:id` route exists —
// 04-FRONTEND.md §2 lists this row with no `:id` child, unlike every other list+detail pair in
// the same table, so `MerchantCampaignsPage` renders the detail as a `Drawer` on this one URL
// rather than a second route.
const MerchantCampaignsPage = lazyPage(
  () => import('../features/merchant'),
  'MerchantCampaignsPage',
);

export interface ProtectedRouteSpec {
  /** Exactly as it appears in 04-FRONTEND.md §2 — a leading `/`, `:param` segments as-is. */
  readonly path: string;
  /** A concrete path to request in tests when `path` contains a `:param` segment. */
  readonly testPath?: string;
  readonly label: string;
  /** Omitted means "any authenticated user" (e.g. `/dashboard`). */
  readonly entity?: string;
  /** Defaults to `'view'` when `entity` is set. */
  readonly action?: string;
}

export const PROTECTED_ROUTE_SPECS: readonly ProtectedRouteSpec[] = [
  { path: '/dashboard', label: 'Dashboard' },
  // T-024 — `/change-password` used to be listed here; it now has its own top-level route
  // (`buildRouteObjects` below) instead of going through `ProtectedLayout`. See
  // `ChangePasswordPage.tsx`'s file banner for why.
  { path: '/countries', label: 'Countries', entity: 'country', action: 'view' },
  {
    path: '/countries/:id',
    testPath: '/countries/1',
    label: 'Country detail',
    entity: 'country',
    action: 'view',
  },
  { path: '/rules', label: 'Rules', entity: 'rule', action: 'view' },
  {
    path: '/rules/:id',
    testPath: '/rules/1',
    label: 'Rule detail',
    entity: 'rule',
    action: 'view',
  },
  { path: '/rewards', label: 'Rewards', entity: 'reward', action: 'view' },
  {
    path: '/rewards/:id',
    testPath: '/rewards/1',
    label: 'Reward detail',
    entity: 'reward',
    action: 'view',
  },
  { path: '/tenants', label: 'Tenants', entity: 'tenant', action: 'view' },
  {
    path: '/tenants/:id',
    testPath: '/tenants/1',
    label: 'Tenant detail',
    entity: 'tenant',
    action: 'view',
  },
  { path: '/users', label: 'Users', entity: 'user', action: 'view' },
  {
    path: '/users/:id',
    testPath: '/users/1',
    label: 'User detail',
    entity: 'user',
    action: 'view',
  },
  { path: '/merchants', label: 'Merchants', entity: 'merchant', action: 'view' },
  {
    path: '/merchants/:id',
    testPath: '/merchants/1',
    label: 'Merchant detail',
    entity: 'merchant',
    action: 'view',
  },
  { path: '/campaigns', label: 'Campaigns', entity: 'campaign', action: 'view' },
  { path: '/campaigns/new', label: 'New campaign', entity: 'campaign', action: 'create' },
  {
    path: '/campaigns/new/journey',
    label: 'Journey builder',
    entity: 'campaign',
    action: 'create',
  },
  // T-049 — listed before `/campaigns/:id` for readability only; React Router ranks a static
  // segment above a dynamic one regardless of table order.
  { path: '/campaigns/assistant', label: 'Create with AI', entity: 'campaign', action: 'create' },
  {
    path: '/campaigns/:id',
    testPath: '/campaigns/1',
    label: 'Campaign detail',
    entity: 'campaign',
    action: 'view',
  },
  { path: '/approvals', label: 'Approvals', entity: 'approval', action: 'view' },
  {
    path: '/approvals/:id',
    testPath: '/approvals/1',
    label: 'Approval detail',
    entity: 'approval',
    action: 'view',
  },
  { path: '/merchant/campaigns', label: 'My campaigns', entity: 'campaign', action: 'view' },
  {
    path: '/admin/access-control',
    label: 'Access Control',
    entity: 'access_control',
    action: 'view',
  },
  { path: '/audit', label: 'Audit log', entity: 'audit', action: 'view' },
  // T-041 — 06-VERSIONING.md §10 ("Blast history | super_admin, country_admin"). No
  // `entity`/`action`: access here is a static role check, not a `role_entity_permissions`
  // grant — see `BlastHistoryPage.tsx`'s own header for the full reasoning.
  { path: '/blasts', label: 'Blast history' },
  // T-042 — 06-VERSIONING.md §10 ("Definition requests | all (raise), super_admin (triage)").
  // `entity`/`action` mirror `T042_001`'s own seed (`DEFINITION_REQUEST_ENTITY`, 'view') —
  // granted to `country_admin`/`tenant_admin`/`super_admin` only, never `maker`/`checker`/
  // `merchant` (implementation note 8).
  {
    path: '/definition-requests',
    label: 'Definition Requests',
    entity: 'definition_request',
    action: 'view',
  },
  {
    path: '/definition-requests/:id',
    testPath: '/definition-requests/1',
    label: 'Definition request detail',
    entity: 'definition_request',
    action: 'view',
  },
  // T-045 — 08-OBSERVABILITY.md §6. No `entity`/`action`: unlike every other row here, access is
  // not a `role_entity_permissions` grant a Super Admin could hand to someone else — it is the
  // static `@Roles('super_admin')` check `trace.controller.ts`'s own header explains at length.
  // `TraceViewerPage` enforces that role check itself (see its own header) rather than through
  // `RequirePermission`, which has no row for this entity for *any* role and would 403 a Super
  // Admin along with everyone else.
  {
    path: '/trace/:correlationId',
    testPath: '/trace/01J8F3K9QP2M7N00000000',
    label: 'Trace viewer',
  },
];

function toChildPath(path: string): string {
  return path.replace(/^\//, '');
}

/**
 * T-045's one deviation from "every screen is a placeholder": `/trace/:correlationId` renders the
 * real `TraceViewerPage` rather than `RouteStub`, because that screen is this task's own scope
 * (`front-end/src/features/trace/**`) and building it behind a stub — only to immediately swap it
 * out in the same task — would be pure churn. Every other row in `PROTECTED_ROUTE_SPECS` is still
 * a future task's screen to build, exactly as T-020 left it.
 */
function buildProtectedChild(spec: ProtectedRouteSpec): RouteObject {
  const content =
    spec.path === '/trace/:correlationId' ? (
      <TraceViewerPage />
    ) : spec.path === '/dashboard' ? (
      <DashboardPage />
    ) : spec.path === '/countries' ? (
      <CountriesListPage />
    ) : spec.path === '/countries/:id' ? (
      <CountryDetailPage />
    ) : spec.path === '/audit' ? (
      <AuditViewerPage />
    ) : spec.path === '/rules' ? (
      <RulesListPage />
    ) : spec.path === '/rules/:id' ? (
      <RuleDetailPage />
    ) : spec.path === '/rewards' ? (
      <RewardsListPage />
    ) : spec.path === '/rewards/:id' ? (
      <RewardDetailPage />
    ) : spec.path === '/admin/access-control' ? (
      <AccessControlPage />
    ) : spec.path === '/tenants' ? (
      <TenantsListPage />
    ) : spec.path === '/tenants/:id' ? (
      <TenantDetailPage />
    ) : spec.path === '/users' ? (
      <UsersListPage />
    ) : spec.path === '/users/:id' ? (
      <UserDetailPage />
    ) : spec.path === '/merchants' ? (
      <MerchantsListPage />
    ) : spec.path === '/merchants/:id' ? (
      <MerchantDetailPage />
    ) : spec.path === '/blasts' ? (
      <BlastHistoryPage />
    ) : spec.path === '/definition-requests' ? (
      <DefinitionRequestsListPage />
    ) : spec.path === '/definition-requests/:id' ? (
      <DefinitionRequestDetailPage />
    ) : spec.path === '/campaigns' ? (
      <CampaignsListPage />
    ) : spec.path === '/campaigns/new' ? (
      <CampaignWizardPage />
    ) : spec.path === '/campaigns/assistant' ? (
      <AgentChatPage />
    ) : spec.path === '/campaigns/:id' ? (
      <CampaignDetailPage />
    ) : spec.path === '/merchant/campaigns' ? (
      <MerchantCampaignsPage />
    ) : spec.path === '/approvals' ? (
      <ApprovalsQueuePage />
    ) : spec.path === '/approvals/:id' ? (
      <ApprovalDetailPage />
    ) : (
      <RouteStub label={spec.label} />
    );
  return {
    path: toChildPath(spec.path),
    element: spec.entity ? (
      <RequirePermission entity={spec.entity} action={spec.action ?? 'view'}>
        {content}
      </RequirePermission>
    ) : (
      content
    ),
  };
}

export function buildRouteObjects(): RouteObject[] {
  return [
    { path: '/login', element: <LoginPage /> },
    // T-060 — reached only via `LoginPage.tsx`'s `mfaRequired` branch, or a direct visit that
    // still holds a live `__Host-rs_mfa` pending cookie (TC-12/TC-13 handle the case where it
    // does not). See `MfaChallengePage.tsx`'s own file banner.
    { path: '/mfa-challenge', element: <MfaChallengePage /> },
    { path: '/forgot-password', element: <ForgotPasswordPage /> },
    { path: '/reset-password', element: <ResetPasswordPage /> },
    // T-024 — authenticated, but deliberately outside `ProtectedLayout`; see
    // `ChangePasswordPage.tsx`'s file banner.
    { path: '/change-password', element: <ChangePasswordPage /> },
    { path: '/403', element: <Forbidden /> },
    { path: '/404', element: <NotFound /> },
    {
      // A pathless layout route: its children match at the same level as if they were not
      // nested at all, but every one of them is forced through `ProtectedLayout` first
      // (React Router's documented pattern for "wrap many routes in one guard").
      element: (
        <ProtectedLayout>
          {
            // T-083 — one `Suspense` boundary for every lazy page below `ProtectedLayout`,
            // rather than one per route: it sits inside `AppShell` (via `ProtectedLayout`), so
            // navigating between two lazy routes only ever replaces the content area, never the
            // sidebar/top bar. Routes that are still `RouteStub` (a plain, synchronous
            // component) never suspend, so this boundary is a no-op for them.
          }
          <Suspense fallback={<RouteChunkFallback />}>
            <Outlet />
          </Suspense>
        </ProtectedLayout>
      ),
      children: [
        { index: true, element: <Navigate to="/dashboard" replace /> },
        ...PROTECTED_ROUTE_SPECS.map(buildProtectedChild),
        // An unauthenticated visitor to an unknown path is still bounced to `/login` by
        // `RequireAuth` before this is ever reached — see `pages/NotFound.tsx`'s banner.
        { path: '*', element: <NotFound /> },
      ],
    },
  ];
}

export const router = createBrowserRouter(buildRouteObjects(), {
  future: { v7_relativeSplatPath: true },
});
