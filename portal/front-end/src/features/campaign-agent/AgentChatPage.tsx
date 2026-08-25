/**
 * T-049 — `/campaigns/assistant`: *"Create with AI"* (architecture.html §14).
 *
 * The same campaign as the T-037 wizard, built conversationally. This screen is an **accelerator,
 * never the only path** (10-AI §9): every state it can reach — the model being down, a stalled
 * conversation, a refusal it cannot explain — offers the wizard with a working link, because *"a
 * model outage must never block the business"*.
 *
 * ### What this screen may and may not do
 *
 * | It does | It does not |
 * |---|---|
 * | render the server's reply as text | render it as HTML (`MessageStream.tsx`) |
 * | offer the options the server sent | let a maker type an id (`OptionChips.tsx`) |
 * | show the plan and confirm its hash | send a plan of its own (`ReviewPanel.tsx`) |
 * | stop at a **draft** | submit for approval — that stays a human act |
 *
 * The last row is the one the copy repeats out loud, twice (implementation note 4, TC-8).
 *
 * ### Landmarks and focus (implementation note 7)
 *
 * The transcript is a labelled `region` with a heading; what remains to answer is a second labelled
 * region beside it; the review panel and the hand-off each take focus as they appear, so a
 * screen-reader user is never left at the bottom of a stream that changed above them.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { Button } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { PageHeader } from '../../components/PageHeader';
import { Skeleton } from '../../components/Skeleton';
import { MessageStream } from './MessageStream';
import { OptionChips } from './OptionChips';
import { ReviewPanel } from './ReviewPanel';
import { useAgentSession, type AgentOptionKind } from './useAgentSession';

/** Where every fallback points. The wizard is the full-capability path (10-AI §9). */
export const WIZARD_FALLBACK_PATH = '/campaigns/new';

/** §9's own sentence, verbatim — the one thing this screen says that the server did not. */
const UNAVAILABLE_TEXT =
  'The assistant is unavailable — you can still create this campaign in the wizard';

const STALLED_TEXT =
  'This conversation is not getting anywhere — the wizard will be quicker, and nothing you have said is lost';

/** Slot keys (`agent.state.ts#SLOT_STEPS`) as a maker reads them. Falls back to the raw key, so a
 * step added server-side shows up as itself rather than disappearing from the list. */
const STEP_LABEL: Readonly<Record<string, string>> = {
  archetype: 'What kind of campaign',
  name: 'Name',
  campaignCode: 'Short code',
  startDate: 'Start date',
  endDate: 'End date',
  budget: 'Budget and currency',
  merchants: 'Participating merchants',
  activities: 'Activities tracked',
  tracker: 'Tracker and how it completes',
  rules: 'Rules for each activity',
  ruleValues: 'Values for those rules',
  rewards: 'Rewards and where they attach',
};

const OPTION_KINDS: readonly AgentOptionKind[] = ['merchants', 'activities', 'rules', 'rewards'];

/**
 * Guards the hand-off link against anything that is not an in-app path.
 *
 * `handOff.wizardPath` is built by the server from a constant (`agent.constants.ts#WIZARD_PATH`),
 * so this cannot fire today. It is here because "a URL from a response body, rendered as a link"
 * is the shape of an open redirect, and the check costs one line — `//evil.example` is a
 * protocol-relative URL that looks like a path.
 */
function toInAppPath(path: string): string {
  return /^\/[^/\\]/.test(path) ? path : '/campaigns';
}

export function AgentChatPage() {
  const agent = useAgentSession();
  const [draft, setDraft] = useState('');
  const handOffRef = useRef<HTMLHeadingElement>(null);

  const created = agent.created;

  useEffect(() => {
    if (created !== null) handOffRef.current?.focus();
  }, [created]);

  const conversationOver = created !== null;
  const showReview = agent.plan !== null && !conversationOver;
  const canReview =
    agent.progress?.complete === true && agent.plan === null && !conversationOver && !agent.busy;

  /**
   * A policy refusal is rendered **inside** the review panel when the panel is on screen — that is
   * where the maker is looking, and where the thing being refused is. Rendering it in both places
   * would announce the same `role="alert"` twice to a screen reader, which reads as two problems.
   */
  const failureBelongsToPanel = showReview && agent.failure?.kind === 'policy';

  return (
    <div className="p-6">
      <PageHeader
        title="Create with AI"
        description="The assistant asks questions and offers choices drawn from your own master data. It stops at a draft — submitting for approval stays with you."
        actions={
          <Link
            to={WIZARD_FALLBACK_PATH}
            className="text-sm font-medium text-primary-700 underline hover:text-primary-800"
          >
            Use the wizard instead
          </Link>
        }
      />

      {agent.offerWizard && (
        <div
          role="status"
          className="mb-4 flex flex-wrap items-center gap-2 rounded-card border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <Sparkles className="size-4" aria-hidden="true" />
          <span>{agent.failure?.kind === 'unavailable' ? UNAVAILABLE_TEXT : STALLED_TEXT}.</span>
          <Link
            to={WIZARD_FALLBACK_PATH}
            className="font-semibold text-amber-900 underline hover:text-amber-950"
          >
            Create this campaign in the wizard
          </Link>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section aria-labelledby="agent-chat-heading" className="grid gap-3">
          <Card className="overflow-hidden">
            <CardHeader className="flex items-center justify-between gap-2">
              <h2 id="agent-chat-heading" className="text-sm font-semibold text-slate-800">
                Conversation
              </h2>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={agent.busy || agent.starting}
                onClick={agent.restart}
              >
                Start over
              </Button>
            </CardHeader>

            {agent.starting ? (
              <CardBody>
                <Skeleton className="h-24 w-full" />
              </CardBody>
            ) : (
              <>
                <MessageStream messages={agent.messages} busy={agent.busy} />

                {!conversationOver &&
                  OPTION_KINDS.map((kind) => (
                    <OptionChips
                      key={kind}
                      kind={kind}
                      options={agent.options[kind]}
                      disabled={agent.busy}
                      onChoose={agent.choose}
                    />
                  ))}

                {agent.failure !== null &&
                  agent.failure.kind !== 'unavailable' &&
                  !failureBelongsToPanel && (
                    <div className="border-t border-slate-200 px-4 py-3">
                      <p role="alert" className="text-sm text-rose-700">
                        {agent.failure.message}
                        {agent.failure.codes.length > 0 && (
                          <span className="mt-1 block text-xs">
                            {agent.failure.codes
                              .map((code) => code.replaceAll('_', ' ').toLowerCase())
                              .join(' · ')}
                          </span>
                        )}
                      </p>
                      {agent.failure.retryable && (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="mt-2"
                          disabled={agent.busy}
                          onClick={agent.retry}
                        >
                          Try again
                        </Button>
                      )}
                    </div>
                  )}

                {showReview && agent.plan !== null && (
                  <div className="border-t border-slate-200 p-4">
                    <ReviewPanel
                      plan={agent.plan}
                      busy={agent.busy}
                      failure={agent.failure?.kind === 'policy' ? agent.failure : null}
                      onConfirm={agent.confirmPlan}
                      onKeepEditing={agent.keepEditing}
                    />
                  </div>
                )}

                {canReview && (
                  <div className="border-t border-slate-200 px-4 py-3">
                    <Button type="button" onClick={agent.requestPlan}>
                      Review the campaign
                    </Button>
                  </div>
                )}

                {conversationOver ? (
                  <HandOff
                    headingRef={handOffRef}
                    campaignCode={created.campaign.campaignCode}
                    message={created.handOff.message}
                    wizardPath={created.handOff.wizardPath}
                  />
                ) : (
                  <form
                    className="grid gap-2 border-t border-slate-200 p-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      agent.send(draft);
                      setDraft('');
                    }}
                  >
                    <label
                      htmlFor="agent-message"
                      className="text-xs font-semibold uppercase tracking-wide text-slate-500"
                    >
                      Your message
                    </label>
                    <textarea
                      id="agent-message"
                      rows={2}
                      value={draft}
                      disabled={agent.busy}
                      maxLength={4000}
                      onChange={(event) => {
                        setDraft(event.target.value);
                      }}
                      className="w-full rounded-control border border-slate-300 px-3 py-2 text-sm text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 disabled:bg-slate-50"
                    />
                    <div>
                      <Button type="submit" isLoading={agent.busy} disabled={draft.trim() === ''}>
                        Send
                      </Button>
                    </div>
                  </form>
                )}
              </>
            )}
          </Card>
        </section>

        <section aria-labelledby="agent-progress-heading" className="grid gap-3">
          <Card>
            <CardHeader>
              <h2 id="agent-progress-heading" className="text-sm font-semibold text-slate-800">
                Still to answer
              </h2>
            </CardHeader>
            <CardBody className="grid gap-2 text-sm text-slate-700">
              {agent.progress === null ? (
                <p className="text-slate-500">Opening the conversation…</p>
              ) : agent.progress.missing.length === 0 ? (
                <p>Everything is answered — review the campaign and create the draft.</p>
              ) : (
                <>
                  <p className="text-slate-600">{agent.progress.nextStep}</p>
                  <ul className="grid list-disc gap-0.5 pl-4">
                    {agent.progress.missing.map((step) => (
                      <li key={step}>{STEP_LABEL[step] ?? step}</li>
                    ))}
                  </ul>
                </>
              )}
            </CardBody>
          </Card>
        </section>
      </div>
    </div>
  );
}

interface HandOffProps {
  readonly headingRef: RefObject<HTMLHeadingElement>;
  readonly campaignCode: string;
  readonly message: string;
  readonly wizardPath: string;
}

/** 10-AI §4 step 11 — the hand-off. The message is the server's own; the link is checked before
 * it is rendered (see {@link toInAppPath}). */
function HandOff({ headingRef, campaignCode, message, wizardPath }: HandOffProps) {
  return (
    <section
      aria-labelledby="agent-handoff-heading"
      className="grid gap-2 border-t border-slate-200 bg-emerald-50 p-4"
    >
      <h3
        id="agent-handoff-heading"
        ref={headingRef}
        tabIndex={-1}
        className="text-sm font-semibold text-emerald-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
      >
        Created as draft {campaignCode}
      </h3>
      <p className="text-sm text-emerald-900">{message}</p>
      <div>
        <Link
          to={toInAppPath(wizardPath)}
          className="text-sm font-semibold text-emerald-900 underline hover:text-emerald-950"
        >
          Open {campaignCode} in the wizard
        </Link>
      </div>
      <p className="text-sm text-emerald-900">
        It has <strong>not</strong> been submitted for approval — open it in the wizard when you are
        ready to submit it.
      </p>
    </section>
  );
}
