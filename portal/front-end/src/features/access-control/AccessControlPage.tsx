/**
 * T-033 — `/admin/access-control`, reached through `router.tsx`'s
 * `RequirePermission entity="access_control" action="view"` guard (itself `super_admin`-only per
 * `role_entity_permissions`' seed — TC-5's front-end half: the nav item is absent for every other
 * role, and the route itself answers Forbidden if reached directly).
 *
 * One role at a time (`Tabs`, TC-1's "all six roles listed"), three sections per role
 * (nested `Tabs`: Navigation / Permissions / Dashboard), plus a Preview action per role.
 */
import { useState } from 'react';
import { Eye } from 'lucide-react';
import type { SharedPortalRole } from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/PageHeader';
import { Skeleton } from '../../components/Skeleton';
import { Tabs, type TabItem } from '../../components/Tabs';
import { ApiError } from '../../lib/apiError';
import { NavConfigEditor } from './NavConfigEditor';
import { PermissionsMatrixEditor } from './PermissionsMatrixEditor';
import { PreviewModal } from './PreviewModal';
import { WidgetsConfigEditor } from './WidgetsConfigEditor';
import { useRolesQuery } from './api';

const ROLE_LABEL: Record<SharedPortalRole, string> = {
  super_admin: 'Super Admin',
  country_admin: 'Country Admin',
  tenant_admin: 'Tenant Admin',
  maker: 'Maker',
  checker: 'Checker',
  merchant: 'Merchant',
};

function RoleSections({ role }: { role: SharedPortalRole }) {
  const [section, setSection] = useState('nav');

  const sections: TabItem[] = [
    { value: 'nav', label: 'Navigation', panel: <NavConfigEditor role={role} /> },
    { value: 'permissions', label: 'Permissions', panel: <PermissionsMatrixEditor role={role} /> },
    { value: 'widgets', label: 'Dashboard', panel: <WidgetsConfigEditor role={role} /> },
  ];

  return <Tabs items={sections} value={section} onChange={setSection} />;
}

export function AccessControlPage() {
  const rolesQuery = useRolesQuery();
  const [activeRole, setActiveRole] = useState<SharedPortalRole>('super_admin');
  const [previewOpen, setPreviewOpen] = useState(false);

  const error = rolesQuery.error instanceof ApiError ? rolesQuery.error : null;

  const roleTabs: TabItem[] =
    rolesQuery.data?.map((summary) => ({
      value: summary.role,
      label: `${ROLE_LABEL[summary.role]} (${String(summary.userCount)})`,
      panel: <RoleSections role={summary.role} />,
    })) ?? [];

  return (
    <div className="p-6">
      <PageHeader
        title="Access Control"
        description="Give and block access for every role — what they can see, create and update."
        actions={
          <Button type="button" variant="secondary" onClick={() => setPreviewOpen(true)}>
            <Eye className="size-4" aria-hidden="true" />
            Preview {ROLE_LABEL[activeRole]}
          </Button>
        }
      />

      {rolesQuery.isLoading && (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-8" />
          <Skeleton className="h-40" />
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-700">
          {error.message}
        </p>
      )}

      {roleTabs.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {rolesQuery.data?.map((summary) => (
            <Badge key={summary.role} tone={summary.role === activeRole ? 'primary' : 'slate'}>
              {ROLE_LABEL[summary.role]}: {summary.userCount} user
              {summary.userCount === 1 ? '' : 's'}
            </Badge>
          ))}
        </div>
      )}

      {roleTabs.length > 0 && (
        <div className="mt-4">
          <Tabs
            items={roleTabs}
            value={activeRole}
            onChange={(value) => setActiveRole(value as SharedPortalRole)}
          />
        </div>
      )}

      <PreviewModal open={previewOpen} onClose={() => setPreviewOpen(false)} role={activeRole} />
    </div>
  );
}
