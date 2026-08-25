/**
 * T-015 — the aggregation behind `GET /me/bootstrap`: the single call that drives the entire UI.
 *
 * 00-ARCHITECTURE.md §7: *"The front end contains **no hard-coded menu and no hard-coded dashboard
 * layout**."* Everything the SPA renders after login comes from this one payload, for all six
 * roles, which makes two properties of this file load-bearing:
 *
 *  - **It must be correct per role, not merely correct.** A bootstrap that is right for a maker
 *    and wrong for a merchant is the failure mode T-015's Definition of Done singles out, and it
 *    is invisible until somebody logs in as the other role. Everything below is keyed on
 *    `actor.role` — from the verified JWT (R3) — and nothing on anything a client can send.
 *  - **Hiding a link is not a control.** A nav item absent from this payload is a link the SPA
 *    does not draw; the request it would have made is still refused by `PermissionsGuard` reading
 *    the same `role_entity_permissions` table (§7: *"Hiding a link never stands alone as a
 *    control"*). Nothing in this file may ever become the only thing standing between a role and
 *    an operation.
 *
 * ### Two phases, because a 304 must be cheap
 *
 * {@link BootstrapService.revision} reads only what the `ETag` is computed from — the caller's row
 * and `rbac_version:<role>` — and {@link BootstrapService.assemble} does the rest. A conditional
 * request that hits therefore costs two indexed single-row reads and no nav, widget, permission or
 * message work at all. Splitting it this way is what makes implementation note 8's *"p95 < 100 ms
 * warm"* comfortable rather than tight, since the SPA revalidates on focus and most of those
 * revalidations are 304s.
 *
 * Both phases batch with `Promise.all` — "one round of queries" (note 8). The permission matrix is
 * usually not a query at all: `PermissionCacheService` serves it from memory, re-reading only when
 * `rbac_version` moved (T-013).
 *
 * ### The ETag, and what it does and does not invalidate
 *
 * `W/"<role>-<rbacVersion>-<userUpdatedAt>"` (note 6). The middle term is read **live** on every
 * request, never taken from the JWT: a token is valid for fifteen minutes, so a claim-borne
 * version would keep serving a 304 for fifteen minutes after a Super Admin changed the role's
 * menu. The third term is what makes `PATCH /me` visible immediately to the caller's own tabs.
 *
 * A conditional request is the only thing the ETag affects. An unconditional `GET /me/bootstrap`
 * re-reads `role_nav_configs` and `role_dashboard_widgets` every time and is therefore correct
 * even when a row was toggled without the version being bumped (TC-7/TC-8). That is deliberate:
 * the nav tables are small and role-keyed, and caching them in this process would trade a
 * measurable-but-tiny latency win for a class of "the menu is stale on one instance" bug.
 *
 * Known gap, flagged for the architect in the completion report: an edit to `system_messages`
 * moves no term of the ETag, so a client holding a conditional request would keep the previous
 * catalogue until something else changed. §7 defines the ETag as `role + rbac_version` and note 6
 * adds the user timestamp; neither mentions the catalogue, so this implements the spec rather than
 * inventing a fourth term.
 */
import { Inject, Injectable } from '@nestjs/common';
import { MessageService } from '@/common/messages/message.service';
import { PERMISSION_STORE, type PermissionStore } from '@/common/rbac/permission.repository';
import { PermissionCacheService, type PermissionMap } from '@/common/rbac/permission-cache.service';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { RoleDashboardWidget, RoleNavConfig } from '@/database/models';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import type {
  BootstrapDto,
  BootstrapNavItemDto,
  BootstrapPermissionsDto,
  BootstrapUserDto,
  BootstrapWidgetDto,
} from './dto/bootstrap-response.dto';
import { DEFAULT_LOCALE, MeService, scopeOf } from './me.service';

/**
 * Everything phase one produced: the `ETag` and the `user` block, which is built from the same row
 * the timestamp came from and so needs no second read in phase two.
 */
export interface BootstrapRevision {
  readonly etag: string;
  readonly user: BootstrapUserDto;
}

@Injectable()
export class BootstrapService {
  constructor(
    private readonly scoped: ScopedRepository,
    private readonly permissions: PermissionCacheService,
    @Inject(PERMISSION_STORE) private readonly permissionStore: PermissionStore,
    private readonly messages: MessageService,
    private readonly me: MeService,
  ) {}

  /** Phase one — the two reads the `ETag` is computed from. See the file header. */
  async revision(actor: AuthenticatedUser): Promise<BootstrapRevision> {
    const [row, rbacVersion] = await Promise.all([
      this.me.findSelf(actor),
      this.permissionStore.readRbacVersion(actor.role),
    ]);

    return {
      etag: buildBootstrapEtag(actor.role, rbacVersion, row.updatedAt),
      user: {
        id: row.id,
        displayName: row.displayName,
        // Identity from the token, profile data from the row — see `me.service.ts`.
        role: actor.role,
        locale: row.preferredLocale ?? DEFAULT_LOCALE,
        timezone: row.preferredTimezone,
      },
    };
  }

  /**
   * Phase two — nav, widgets, permissions and the message catalogue, batched.
   *
   * Both table reads filter on `role = actor.role AND enabled = true` and order by `sort_order`,
   * which is implementation note 2 and note 4 verbatim. `nav_key` / `widget_key` is the tiebreaker
   * so two rows sharing a `sort_order` produce a stable order rather than the planner's.
   *
   * `listAll` rather than `findAll` — the same `ScopedRepository` method under the name a service
   * outside `src/common/scope/` is able to call. See that method's own comment; the short version
   * is that T-013's `no-raw-model-access` rule bans the property name `findAll` on every receiver,
   * deliberately, and this is the sanctioned way to satisfy R2 without touching the rule.
   */
  async assemble(actor: AuthenticatedUser, revision: BootstrapRevision): Promise<BootstrapDto> {
    const [navRows, widgetRows, permissions] = await Promise.all([
      this.scoped.listAll(RoleNavConfig, {
        where: { role: actor.role, enabled: true },
        order: [
          ['sortOrder', 'ASC'],
          ['navKey', 'ASC'],
        ],
      }),
      this.scoped.listAll(RoleDashboardWidget, {
        where: { role: actor.role, enabled: true },
        order: [
          ['sortOrder', 'ASC'],
          ['widgetKey', 'ASC'],
        ],
      }),
      this.permissions.permissionsFor(actor.role),
    ]);

    return {
      user: revision.user,
      scope: scopeOf(actor),
      nav: buildNavTree(navRows.map(toNavSource)),
      permissions: toPermissionsDto(permissions),
      widgets: widgetRows.map(toWidget),
      messages: this.messages.getAll(),
    };
  }
}

// --- pure helpers ------------------------------------------------------------------------------
// Exported and free of dependencies so every branch below — orphans, cycles, malformed configs,
// weak ETag comparison — is testable as a function rather than through an HTTP round trip.

/**
 * `W/"<role>-<rbacVersion>-<userUpdatedAt>"` (implementation note 6).
 *
 * Weak (`W/`) because the payload is semantically, not byte-for-byte, equivalent between two
 * responses at the same revision — `messages` comes from a catalogue refreshed on a timer, and key
 * order in a JSON object is not something the client cares about. Weak is also the only correct
 * strength for a comparison `If-None-Match` performs weakly regardless (RFC 7232 §3.2).
 *
 * A missing or invalid timestamp degrades to `0` rather than throwing: `updated_at` is `NOT NULL`,
 * so this cannot happen against the real schema, and an endpoint on the critical path of every
 * login must not 500 over a cache key. The consequence of `0` is a stable ETag that changes when
 * the role's version does — degraded, never wrong.
 */
export function buildBootstrapEtag(
  role: string,
  rbacVersion: number,
  userUpdatedAt: Date | null | undefined,
): string {
  const millis = userUpdatedAt instanceof Date ? userUpdatedAt.getTime() : Number.NaN;
  const stamp = Number.isFinite(millis) ? String(millis) : '0';
  return `W/"${role}-${rbacVersion}-${stamp}"`;
}

/**
 * Whether an `If-None-Match` header matches `etag`, by the **weak** comparison RFC 7232 §3.2
 * mandates for this header: the `W/` prefix is ignored on both sides and only the opaque tag is
 * compared.
 *
 * `*` matches any current representation, which for this endpoint means "the client holds some
 * version and only wants a body if one exists" — it always does, so `*` is a 304.
 *
 * Deliberately not delegating to Express's `req.fresh`: that helper also consults
 * `Cache-Control: no-cache` **on the request**, and answers `false` whenever a client sends one —
 * which a hard refresh does. Doing the comparison here keeps the 304 decision in one readable
 * place, and matching Express's own semantics on the tag itself means the two cannot disagree
 * about a response this handler has already decided to send.
 */
export function ifNoneMatchSatisfiedBy(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;

  const trimmed = header.trim();
  if (trimmed === '') return false;
  if (trimmed === '*') return true;

  const target = opaqueTag(etag);
  return trimmed.split(',').some((candidate) => opaqueTag(candidate.trim()) === target);
}

/** `W/"abc"` → `"abc"`; `"abc"` → `"abc"`. */
function opaqueTag(value: string): string {
  return value.startsWith('W/') ? value.slice(2) : value;
}

/** The subset of a `role_nav_configs` row the tree builder needs. */
export interface NavSource {
  readonly key: string;
  readonly label: string;
  readonly icon: string | null;
  readonly path: string;
  readonly parentKey: string | null;
}

function toNavSource(row: RoleNavConfig): NavSource {
  return {
    key: row.navKey,
    label: row.label,
    icon: row.icon,
    path: row.path,
    parentKey: row.parentNavKey,
  };
}

/**
 * Nests the enabled rows of one role by `parent_nav_key`, preserving the order they arrive in.
 *
 * ### An orphan is dropped, never promoted (implementation note 2, TC-8)
 *
 * > *"An orphan child (parent missing or disabled) must be dropped, not promoted to top level —
 * > otherwise disabling a parent leaks its children into the menu."*
 *
 * This is the failure mode the task file calls one of the two this endpoint is most likely to ship
 * with, and it is a real privilege-shaped bug rather than a cosmetic one: a Super Admin who
 * disables "Access Control" and sees its children appear as top-level menu entries has been told
 * by the UI that the section is off while it is, visibly, on.
 *
 * The rule is applied **transitively** — a grandchild whose parent survives but whose grandparent
 * does not is also dropped — because the alternative gives the same leak one level down. `rows` is
 * only one level deep in the shipped seed (01-DATABASE.md §5.2), so the recursion is written for
 * the configuration a Super Admin can create through T-033, not for the one that exists today.
 *
 * ### Two degenerate inputs that must not hang the request
 *
 * A row that is its own parent, and a cycle across several rows, are both reachable through direct
 * SQL (`role_nav_configs` has no constraint against either). Both resolve to "not reachable from a
 * root" and are dropped, by walking the ancestor chain with a visited set rather than recursing
 * blindly. An endpoint every login depends on must not be a place where a bad configuration row
 * becomes an infinite loop.
 */
export function buildNavTree(rows: readonly NavSource[]): BootstrapNavItemDto[] {
  // `(role, nav_key)` is unique, so a duplicate key cannot occur against the real schema. If one
  // ever does, the first row in sort order wins and the rest are ignored — one node per key,
  // rather than a tree with two nodes claiming the same identity.
  const byKey = new Map<string, NavSource>();
  for (const row of rows) {
    if (!byKey.has(row.key)) byKey.set(row.key, row);
  }

  const reachable = reachabilityOf(byKey);

  /** `parentKey → the children array of that node`, created on demand in either order. */
  const childrenOf = new Map<string, BootstrapNavItemDto[]>();
  const bucket = (key: string): BootstrapNavItemDto[] => {
    const existing = childrenOf.get(key);
    if (existing !== undefined) return existing;
    const created: BootstrapNavItemDto[] = [];
    childrenOf.set(key, created);
    return created;
  };

  const roots: BootstrapNavItemDto[] = [];

  for (const row of rows) {
    if (byKey.get(row.key) !== row) continue;
    if (!reachable(row.key)) continue;

    // `children` *is* this node's bucket: a child processed before its parent pushes into the same
    // array the parent later adopts, so one pass suffices whatever order the rows arrive in.
    const node: BootstrapNavItemDto = {
      key: row.key,
      label: row.label,
      icon: row.icon,
      path: row.path,
      children: bucket(row.key),
    };

    if (row.parentKey === null) roots.push(node);
    else bucket(row.parentKey).push(node);
  }

  return roots;
}

/**
 * Builds a memoised "does this key's ancestor chain terminate at a root?" predicate.
 *
 * Walks upwards iteratively, marking the whole chain with the answer it reaches, so the tree costs
 * one pass over the rows regardless of depth. The `onPath` set is what turns a cycle into `false`
 * instead of a hang.
 */
function reachabilityOf(byKey: ReadonlyMap<string, NavSource>): (key: string) => boolean {
  const memo = new Map<string, boolean>();

  return function isReachable(startKey: string): boolean {
    const chain: string[] = [];
    const onPath = new Set<string>();
    let key = startKey;
    let result: boolean;

    for (;;) {
      const cached = memo.get(key);
      if (cached !== undefined) {
        result = cached;
        break;
      }

      const row = byKey.get(key);
      // The parent named by this key is absent from the enabled set — it was disabled, or the
      // key is a typo. Either way the child below it is an orphan.
      if (row === undefined) {
        result = false;
        break;
      }

      if (onPath.has(key)) {
        result = false;
        break;
      }

      onPath.add(key);
      chain.push(key);

      if (row.parentKey === null) {
        result = true;
        break;
      }
      key = row.parentKey;
    }

    for (const visited of chain) memo.set(visited, result);
    return result;
  };
}

/**
 * `{ entity: actions[] }`, entities in a stable alphabetical order.
 *
 * The order is for the reader and for reproducible test output; nothing depends on it. The action
 * arrays keep the order Super Admin authored them in, because `["view","create","update"]` reads
 * as a progression and re-sorting it to `["create","update","view"]` would be a gratuitous change
 * to data this endpoint only transports.
 */
export function toPermissionsDto(permissions: PermissionMap): BootstrapPermissionsDto {
  const result: Record<string, readonly string[]> = {};
  const entries = [...permissions.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [entity, actions] of entries) result[entity] = [...actions];
  return result;
}

function toWidget(row: RoleDashboardWidget): BootstrapWidgetDto {
  return { key: row.widgetKey, label: row.label, config: toWidgetConfig(row.widgetConfig) };
}

/**
 * Normalises `role_dashboard_widgets.widget_config` to an object (implementation note 4, TC-11).
 *
 * > *"A malformed config yields `{}` rather than a failed response."*
 *
 * The model's getter already returns `{}` for unparseable JSON (`parseJsonColumn`, T-003), which
 * covers `not json at all`. It does **not** cover valid JSON that is not an object — `5`, `"kpi"`,
 * `[1,2]` all parse successfully and would otherwise reach the SPA as a `config` it cannot index,
 * turning one bad row into a crashed dashboard for every user of that role. Anything that is not a
 * plain object becomes `{}` here, so `config` is an object unconditionally.
 */
export function toWidgetConfig(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
