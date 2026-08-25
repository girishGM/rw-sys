/**
 * T-038 — the three booleans, and why they are three.
 *
 * `actionable`, `selfSubmitted` and `decidable` are what the SPA renders its Approve/Reject/Return
 * buttons from, and `selfSubmitted` in particular is the segregation-of-duty *fact* shipped to the
 * client. Getting any of them wrong shows a checker a button the server will refuse — or worse,
 * hides one it would have allowed. They are cheap to compute and cheap to test, so every
 * combination is pinned here rather than inferred from the e2e suite.
 *
 * **The service does not trust any of this.** `ApprovalsService` re-derives all three before every
 * write; see `approvals.e2e-spec.ts` for the `curl`-shaped proof (TC-6, TC-17).
 */
import type { TenantCampaign } from '@/database/models';
import type { PortalApprovalRequest } from '@/database/portal-models';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import {
  envelope,
  toApprovalDetailDto,
  toApprovalDto,
  toApprovalSubject,
} from '@/modules/approvals/dto/approval-response.dto';
import type { ApprovalDiff } from '@reward-portal/shared';

const NOW = new Date('2026-08-19T12:00:00.000Z');

function request(overrides: Partial<PortalApprovalRequest> = {}): PortalApprovalRequest {
  return {
    id: 1,
    tenantId: 7,
    entityType: 'campaign',
    entityId: 42,
    action: 'create',
    status: 'pending',
    payload: null,
    requestedBy: 100,
    requestedAt: new Date('2026-08-18T09:00:00.000Z'),
    reviewedBy: null,
    reviewedAt: null,
    reviewComment: null,
    expiresAt: new Date('2026-08-25T09:00:00.000Z'),
    createdAt: new Date('2026-08-18T09:00:00.000Z'),
    updatedAt: new Date('2026-08-18T09:00:00.000Z'),
    ...overrides,
  } as PortalApprovalRequest;
}

function actor(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: 200,
    sessionId: 's',
    role: 'checker',
    countryId: 1,
    tenantId: 7,
    merchantId: null,
    rbacVersion: 1,
    tokenId: 't',
    mustChangePassword: false,
    ...overrides,
  };
}

const NO_CONTEXT = { requesterName: null, reviewerName: null, campaign: null };

describe('T-038 · toApprovalDto — the three booleans', () => {
  it('a pending request, a different checker: actionable, not self-submitted, decidable', () => {
    const dto = toApprovalDto(request(), actor(), NO_CONTEXT, NOW);

    expect(dto.effectiveStatus).toBe('pending');
    expect(dto.actionable).toBe(true);
    expect(dto.selfSubmitted).toBe(false);
    expect(dto.decidable).toBe(true);
  });

  it('TC-6 (the fact): the checker who submitted it sees selfSubmitted, and is not decidable', () => {
    const dto = toApprovalDto(request({ requestedBy: 200 }), actor(), NO_CONTEXT, NOW);

    expect(dto.actionable).toBe(true);
    expect(dto.selfSubmitted).toBe(true);
    expect(dto.decidable).toBe(false);
  });

  it('TC-2: a maker sees the same row, actionable, but never decidable', () => {
    const dto = toApprovalDto(request(), actor({ role: 'maker' }), NO_CONTEXT, NOW);

    expect(dto.actionable).toBe(true);
    expect(dto.selfSubmitted).toBe(false);
    // Read-only view; no approve/reject controls.
    expect(dto.decidable).toBe(false);
  });

  it.each(['super_admin', 'country_admin', 'tenant_admin'] as const)(
    'TC-2: %s sees a read-only row too',
    (role) => {
      const dto = toApprovalDto(request(), actor({ role }), NO_CONTEXT, NOW);
      expect(dto.decidable).toBe(false);
    },
  );

  it.each(['approved', 'rejected', 'returned', 'expired'] as const)(
    'TC-12: an already-%s request is neither actionable nor decidable',
    (status) => {
      const dto = toApprovalDto(request({ status }), actor(), NO_CONTEXT, NOW);

      expect(dto.effectiveStatus).toBe(status);
      expect(dto.actionable).toBe(false);
      expect(dto.decidable).toBe(false);
    },
  );

  it('TC-14: a still-pending row past its deadline reads as expired, whether or not the sweeper ran', () => {
    const dto = toApprovalDto(
      request({ expiresAt: new Date('2026-08-19T11:59:59.000Z') }),
      actor(),
      NO_CONTEXT,
      NOW,
    );

    // The *stored* value is untouched — this is a presentation rule, not a write.
    expect(dto.status).toBe('pending');
    expect(dto.effectiveStatus).toBe('expired');
    expect(dto.actionable).toBe(false);
    expect(dto.decidable).toBe(false);
  });

  it('treats the expiry instant itself as expired (the boundary is inclusive)', () => {
    const dto = toApprovalDto(request({ expiresAt: NOW }), actor(), NO_CONTEXT, NOW);
    expect(dto.effectiveStatus).toBe('expired');
  });

  it('serialises every timestamp as an ISO string and resolves both display names', () => {
    const dto = toApprovalDto(
      request({
        reviewedBy: 200,
        reviewedAt: new Date('2026-08-19T10:00:00.000Z'),
        reviewComment: 'Looks right.',
        status: 'approved',
      }),
      actor(),
      { requesterName: 'Aisha Maker', reviewerName: 'Bo Checker', campaign: null },
      NOW,
    );

    expect(dto.requestedAt).toBe('2026-08-18T09:00:00.000Z');
    expect(dto.reviewedAt).toBe('2026-08-19T10:00:00.000Z');
    expect(dto.expiresAt).toBe('2026-08-25T09:00:00.000Z');
    expect(dto.requestedByName).toBe('Aisha Maker');
    expect(dto.reviewedByName).toBe('Bo Checker');
    expect(dto.reviewComment).toBe('Looks right.');
  });
});

describe('T-038 · toApprovalSubject', () => {
  it('is null when the campaign is absent or out of scope — indistinguishable, by design', () => {
    expect(toApprovalSubject(null)).toBeNull();
  });

  it('resolves the campaign so a checker never sees a bare id', () => {
    const campaign = {
      id: 42,
      campaignCode: 'T038_CODE',
      name: 'Raya bonus',
      status: 'pending_approval',
    } as TenantCampaign;

    expect(toApprovalSubject(campaign)).toEqual({
      campaignId: 42,
      campaignCode: 'T038_CODE',
      campaignName: 'Raya bonus',
      campaignStatus: 'pending_approval',
    });
  });
});

describe('T-038 · envelopes', () => {
  it('wraps a single resource as { data }', () => {
    expect(envelope({ id: 1 })).toEqual({ data: { id: 1 } });
  });

  it('pairs the request with its diff', () => {
    const dto = toApprovalDto(request(), actor(), NO_CONTEXT, NOW);
    const diff: ApprovalDiff = {
      renderable: true,
      problem: null,
      changed: [],
      unchangedCount: 4,
      skippedFields: [],
      budgets: [],
      warnings: [],
      trackerCount: null,
      componentCount: null,
    };

    expect(toApprovalDetailDto(dto, diff)).toEqual({ request: dto, diff });
  });
});
