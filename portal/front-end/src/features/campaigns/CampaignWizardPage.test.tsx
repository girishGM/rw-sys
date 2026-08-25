/**
 * T-076 — the wizard must keep its step across the `/campaigns/new` → `/campaigns/:id` remount.
 *
 * ### Why these cases drive the real route table
 *
 * The defect is not in `CampaignWizardPage` alone and cannot be seen from it alone. `saveBasics`
 * navigates from `/campaigns/new` to `/campaigns/:id`; those are two different `<Route>` entries
 * rendering two different element trees (`<CampaignWizardPage>` directly vs. `<CampaignDetailPage>`
 * which *then* renders the wizard for an editable draft), so React unmounts the wizard and mounts a
 * fresh one. Any test that renders `<CampaignWizardPage>` on its own would never see it.
 *
 * So every case here mounts `buildRouteObjects()` — the same table `app/router.tsx` ships to the
 * browser — in a `createMemoryRouter`, and drives it the way a maker does. If someone re-splits the
 * routes, or moves the wizard back behind a different parent, these fail; a test that hand-built
 * its own two-route table could not (AGENT-PROTOCOL §3: assert the observable property).
 *
 * Only the axios transport is stubbed, following `test/features/campaign-agent/integration.spec.tsx`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Bootstrap, Campaign } from '@reward-portal/shared';

const { mockGet, mockPost, mockPatch, mockPut, mockDelete } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPatch: vi.fn(),
  mockPut: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      create: () => ({
        get: mockGet,
        post: mockPost,
        patch: mockPatch,
        put: mockPut,
        delete: mockDelete,
        interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
      }),
    },
  };
});

import { buildRouteObjects } from '../../app/router';

const CAMPAIGN_ID = 42;

/** An axios-shaped rejection carrying the server's real error envelope (T-014's normaliser). */
function axiosError(status: number, code: string, message: string) {
  return {
    isAxiosError: true,
    response: { status, data: { error: { code, message, traceId: '01J8F3K9QP2M7N00000000' } } },
    message: `Request failed with status code ${String(status)}`,
  };
}

const makerBootstrap: Bootstrap = {
  user: { id: 2, displayName: 'Mo Maker', role: 'maker', locale: 'en', timezone: null },
  scope: { countryId: 1, tenantId: 1, merchantId: null },
  nav: [],
  permissions: { campaign: ['view', 'create', 'update', 'submit'] },
  widgets: [],
  messages: {},
};

function draft(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: CAMPAIGN_ID,
    tenantId: 1,
    campaignCode: 'T076_CAMPAIGN',
    name: 'Step-reset regression campaign',
    description: null,
    startDate: '2027-01-15',
    endDate: '2027-02-15',
    status: 'draft',
    effectiveStatus: 'draft',
    maxParticipants: null,
    budgetAmount: null,
    budgetCurrency: null,
    createdBy: 'Mo Maker',
    approvedBy: null,
    approvedAt: null,
    lastReviewComment: null,
    editable: true,
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * One merchant, so `MerchantsStep` renders its `MultiSelect` rather than its "No merchants yet"
 * empty state — both are step-2 content, but the populated one is what a real maker sees.
 */
const MERCHANT_ROW = {
  id: 7,
  tenantId: 1,
  merchantCode: 'ACME',
  name: 'Acme Electronics',
  description: null,
  contactEmail: null,
  contactPhone: null,
  website: null,
  countryCode: 'MY',
  status: 'active',
  createdAt: '2026-08-21T00:00:00.000Z',
  updatedAt: '2026-08-21T00:00:00.000Z',
};

/**
 * `GET /campaigns/:id/review` — the one sub-resource with a shape richer than "a list", and the
 * only one step 7 renders anything at all from (`ReviewStep` returns `null` without it).
 */
function reviewPayload(campaign: Campaign, submittable = true) {
  return {
    campaign,
    merchants: [],
    journey: { campaignId: campaign.id, trackers: [], campaignRewards: [] },
    caps: [],
    warnings: [],
    ceilings: [],
    worstCasePayout: [],
    issues: [],
    submittable,
  };
}

/** Every GET the wizard and its steps fire; anything unlisted answers with an empty collection. */
function stubGets(campaign: Campaign = draft(), submittable = true): void {
  mockGet.mockImplementation((url: string) => {
    if (url === '/me/bootstrap') return Promise.resolve({ data: { data: makerBootstrap } });
    if (url === `/campaigns/${String(CAMPAIGN_ID)}`) {
      return Promise.resolve({ data: { data: campaign } });
    }
    if (url === `/campaigns/${String(CAMPAIGN_ID)}/review`) {
      return Promise.resolve({ data: { data: reviewPayload(campaign, submittable) } });
    }
    if (url === `/campaigns/${String(CAMPAIGN_ID)}/journey`) {
      return Promise.resolve({
        data: { data: { campaignId: campaign.id, trackers: [], campaignRewards: [] } },
      });
    }
    if (url === '/merchants') {
      return Promise.resolve({
        data: { data: [MERCHANT_ROW], meta: { page: 1, pageSize: 100, total: 1 } },
      });
    }
    return Promise.resolve({ data: { data: [] } });
  });
}

/** `initialEntries` accepts a full location, which is how a restored history entry arrives. */
type Entry = string | { pathname: string; state?: unknown };

function renderAt(entry: Entry) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(buildRouteObjects(), {
    initialEntries: [entry],
    future: { v7_relativeSplatPath: true },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...result, router };
}

/**
 * The `Stepper`'s own accessible marker for "where am I" — `aria-current="step"` plus the
 * `", current step"` sr-only suffix (T-021 TC-14). Read through the accessibility tree rather
 * than off the component's props, because that is what the maker's screen (and screen reader)
 * actually reports.
 */
async function currentStepLabel(): Promise<string> {
  const item = await screen.findByRole('listitem', { current: 'step' });
  // `getByText` matches on an element's *own* text nodes, so the regex lands on the sr-only
  // `", current step"` span itself; its parent is the label span, whose full text is
  // `"Merchants, current step"`.
  const marker = within(item).getByText(/^, current step$/);
  return (marker.parentElement?.textContent ?? '').replace(/, current step$/, '');
}

async function fillBasicsAndCreateDraft(): Promise<void> {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Campaign code'), 'T076_CAMPAIGN');
  await user.type(screen.getByLabelText('Campaign name'), 'Step-reset regression campaign');
  await user.type(screen.getByLabelText('Start date'), '2027-01-15');
  await user.type(screen.getByLabelText('End date'), '2027-02-15');
  await user.click(screen.getByRole('button', { name: 'Create draft' }));
}

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPatch.mockReset();
  mockPut.mockReset();
  mockDelete.mockReset();
});

describe('T-076 — creating a draft lands on step 2 (Merchants)', () => {
  /**
   * TC-1 / TC-2 — the reported defect, reproduced end to end. Red before the fix (the wizard
   * remounts under `/campaigns/:id` and shows "Basics"), green after.
   */
  it('advances to Merchants after "Create draft", across the route remount', async () => {
    stubGets();
    mockPost.mockResolvedValue({ data: { data: draft() } });

    const { router } = renderAt('/campaigns/new');
    await fillBasicsAndCreateDraft();

    // The create really happened and the URL really moved — otherwise the step assertion below
    // would be testing nothing at all.
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/campaigns/${String(CAMPAIGN_ID)}`);
    });
    expect(mockPost).toHaveBeenCalledWith(
      '/campaigns',
      expect.objectContaining({ campaignCode: 'T076_CAMPAIGN' }),
    );

    // TC-3 — the regression assertion. Before the fix this reads "Basics".
    await waitFor(async () => {
      expect(await currentStepLabel()).toBe('Merchants');
    });
    expect(await screen.findByLabelText('Participating merchants')).toBeInTheDocument();
  });

  /**
   * The same journey seen from the URL bar: `/campaigns/new` must not survive as the maker's
   * location, and the entry it replaces must carry enough state to rebuild the step. `replace`
   * is deliberate — a maker pressing Back from a fresh draft should leave the wizard, not
   * return to an empty "new campaign" form that would create a second campaign.
   */
  it('replaces the /campaigns/new history entry rather than pushing onto it', async () => {
    stubGets();
    mockPost.mockResolvedValue({ data: { data: draft() } });

    const { router } = renderAt('/campaigns/new');
    await fillBasicsAndCreateDraft();

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/campaigns/${String(CAMPAIGN_ID)}`);
    });
    expect(router.state.historyAction).toBe('REPLACE');
  });
});

describe('T-076 — the step survives a remount of the wizard', () => {
  /**
   * The property the fix actually rests on, tested independently of the create flow: a wizard
   * that mounts fresh on a history entry which already knows its step opens on that step. This
   * is what a browser reload does (`history.state` is restored with the entry), and it is the
   * same mechanism the create navigation above relies on.
   */
  it('opens on the step the history entry carries', async () => {
    stubGets();

    renderAt({ pathname: `/campaigns/${String(CAMPAIGN_ID)}`, state: { wizardStep: 2 } });

    await waitFor(async () => {
      expect(await currentStepLabel()).toBe('Journey');
    });
  });

  /**
   * TC-4 — adjacent behaviour that must not change. A plain visit to an editable campaign, with
   * no step recorded, still opens on Basics. `test/features/campaign-agent/integration.spec.tsx`
   * (T-049 verification step 7) asserts exactly this for the assistant's hand-off path.
   */
  it('still opens on Basics when the entry carries no step', async () => {
    stubGets();

    renderAt(`/campaigns/${String(CAMPAIGN_ID)}`);

    await waitFor(async () => {
      expect(await currentStepLabel()).toBe('Basics');
    });
  });

  /**
   * A step recorded against a campaign that does not exist yet cannot be honoured — steps 2–7
   * have nothing to attach to (`CampaignWizardPage.tsx`'s "Step gating"). Whatever the history
   * entry claims, `/campaigns/new` opens on Basics rather than on an empty frame.
   */
  it('ignores a recorded step on /campaigns/new, where there is no campaign yet', async () => {
    stubGets();

    renderAt({ pathname: '/campaigns/new', state: { wizardStep: 4 } });

    await waitFor(async () => {
      expect(await currentStepLabel()).toBe('Basics');
    });
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeInTheDocument();
  });

  /** A hand-edited or stale history entry must not put the wizard on a step that isn't there. */
  it('clamps an out-of-range recorded step', async () => {
    stubGets();

    renderAt({ pathname: `/campaigns/${String(CAMPAIGN_ID)}`, state: { wizardStep: 99 } });

    await waitFor(async () => {
      expect(await currentStepLabel()).toBe('Review');
    });
  });

  /** Non-numeric junk in `history.state` is not a crash, it is "no step recorded". */
  it('falls back to Basics when the recorded step is not a step number', async () => {
    stubGets();

    renderAt({ pathname: `/campaigns/${String(CAMPAIGN_ID)}`, state: { wizardStep: 'merchants' } });

    await waitFor(async () => {
      expect(await currentStepLabel()).toBe('Basics');
    });
  });
});

describe('T-076 — TC-4: the footer buttons behave exactly as before', () => {
  it('Next and Back still move one step at a time', async () => {
    stubGets();
    const user = userEvent.setup();

    renderAt(`/campaigns/${String(CAMPAIGN_ID)}`);
    await waitFor(async () => {
      expect(await currentStepLabel()).toBe('Basics');
    });

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(async () => {
      expect(await currentStepLabel()).toBe('Merchants');
    });

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(async () => {
      expect(await currentStepLabel()).toBe('Journey');
    });

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(async () => {
      expect(await currentStepLabel()).toBe('Merchants');
    });
  });

  /**
   * Stepping through the wizard must not fill the browser's history — otherwise Back becomes
   * "undo one step" and a maker six steps in has to press it seven times to leave. Each step
   * change replaces the current entry, exactly like the create navigation.
   */
  it('stepping does not push history entries', async () => {
    stubGets();
    const user = userEvent.setup();

    const { router } = renderAt(`/campaigns/${String(CAMPAIGN_ID)}`);
    await waitFor(async () => {
      expect(await currentStepLabel()).toBe('Basics');
    });

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(async () => {
      expect(await currentStepLabel()).toBe('Merchants');
    });

    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('Next is disabled on /campaigns/new, where no campaign exists to advance to', async () => {
    stubGets();

    renderAt('/campaigns/new');

    expect(await screen.findByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  });

  /**
   * Every step, not just the two the create flow crosses. A step is only worth putting on the
   * history entry if the wizard can actually open on it, and the step index is now read from
   * untrusted input — so each one is opened directly rather than clicked through.
   */
  it.each([
    [0, 'Basics'],
    [1, 'Merchants'],
    [2, 'Journey'],
    [3, 'Rules'],
    [4, 'Rewards'],
    [5, 'Budgets'],
    [6, 'Review'],
  ])('opens directly on step %i (%s)', async (recorded, label) => {
    stubGets();

    renderAt({ pathname: `/campaigns/${String(CAMPAIGN_ID)}`, state: { wizardStep: recorded } });

    await waitFor(async () => {
      expect(await currentStepLabel()).toBe(label);
    });
  });

  it('leaves a non-draft campaign on the read-only detail view, not the wizard', async () => {
    stubGets(draft({ status: 'active', effectiveStatus: 'active', editable: false }));

    renderAt({ pathname: `/campaigns/${String(CAMPAIGN_ID)}`, state: { wizardStep: 3 } });

    expect(await screen.findByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { current: 'step' })).toBeNull();
  });
});

describe('T-076 — TC-4: the other two step-changing paths still behave', () => {
  /**
   * A failed create must not move the maker anywhere. This is the mirror image of the defect:
   * the step and the URL now change together, so a create that never produced a campaign has to
   * leave both alone — otherwise the wizard would advance to a step with nothing behind it.
   */
  it('stays on Basics, and on /campaigns/new, when the create fails', async () => {
    stubGets();
    mockPost.mockRejectedValue(
      axiosError(409, 'CAMPAIGN_CODE_TAKEN', 'That campaign code is already in use.'),
    );

    const { router } = renderAt('/campaigns/new');
    await fillBasicsAndCreateDraft();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That campaign code is already in use.',
    );
    expect(router.state.location.pathname).toBe('/campaigns/new');
    expect(await currentStepLabel()).toBe('Basics');
  });

  /**
   * The step the create flow now lands on has to be *usable* once it gets there, not merely
   * displayed: the remount that lost the step also rebuilt every query on this screen, so the
   * step-2 control is driven here for real rather than asserted to exist.
   */
  it('saves a merchant selection on the step the create flow lands on', async () => {
    stubGets();
    mockPost.mockResolvedValue({ data: { data: [] } });
    const user = userEvent.setup();

    renderAt({ pathname: `/campaigns/${String(CAMPAIGN_ID)}`, state: { wizardStep: 1 } });

    await user.click(await screen.findByLabelText('Participating merchants'));
    await user.click(await screen.findByRole('option', { name: /Acme Electronics/ }));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(`/campaigns/${String(CAMPAIGN_ID)}/merchants`, {
        merchantIds: [MERCHANT_ROW.id],
      });
    });
  });

  /**
   * A returned campaign is a draft again, and the checker's reason has to survive the same
   * remount the step does — it is the one piece of context telling the maker why they are back
   * in the wizard at all.
   */
  it('shows the checker comment on a returned draft', async () => {
    stubGets(draft({ lastReviewComment: 'The end date runs past the budget period.' }));

    renderAt({ pathname: `/campaigns/${String(CAMPAIGN_ID)}`, state: { wizardStep: 1 } });

    expect(
      await screen.findByText(/The end date runs past the budget period\./),
    ).toBeInTheDocument();
  });

  /**
   * Submitting is the wizard's other navigation, and it was the other `navigate()`-then-`setStep()`
   * pair. It ends the wizard rather than advancing it, so what matters is that the step it records
   * is the one the maker was on — a checker returning the campaign makes it a draft again, and it
   * should reopen where it was left, not back at Basics.
   */
  it('records the Review step on the entry it leaves behind when submitting', async () => {
    stubGets();
    mockPost.mockImplementation((url: string) => {
      if (url === `/campaigns/${String(CAMPAIGN_ID)}/submit`) {
        return Promise.resolve({
          data: {
            data: {
              campaign: draft({ status: 'pending_approval', effectiveStatus: 'pending_approval' }),
              approvalRequestId: 9,
              expiresAt: '2026-08-24T00:00:00.000Z',
            },
          },
        });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    const user = userEvent.setup();

    const { router } = renderAt({
      pathname: `/campaigns/${String(CAMPAIGN_ID)}`,
      state: { wizardStep: 6 },
    });

    await user.click(await screen.findByRole('button', { name: 'Submit for approval' }));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(`/campaigns/${String(CAMPAIGN_ID)}/submit`, {});
    });
    await waitFor(() => {
      expect(router.state.location.state).toMatchObject({ wizardStep: 6 });
    });
  });
});
