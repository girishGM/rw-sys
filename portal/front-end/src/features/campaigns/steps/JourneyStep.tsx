/**
 * T-037 step 3 — the **journey builder** (04-FRONTEND.md §5.3, implementation note 4:
 * *"the journey structure is the heart of this task"*).
 *
 * > *"A linear form cannot express a nested structure, so step 3 is a two-pane builder: a tree of
 * > trackers and components on the left, a configuration panel for the selected node on the
 * > right."*
 *
 * Three things this screen is careful to say out loud, because each is a rule a maker cannot
 * infer from the controls:
 *
 *  - **`is_mandatory` overrides `n_of`** (implementation note 5). *"If a tracker is 'any 2 of 3'
 *    and component 1 is mandatory, completing components 2 and 3 does not finish the tracker."*
 *    The note requires this to be stated in the UI, so the mandatory toggle carries it.
 *  - **`sequence_order` is display and intent order in v1, not an enforced gate** (note 6). A
 *    maker who assumes ordering is enforced would build a journey that behaves differently from
 *    the one they designed, so the panel says it is not.
 *  - **`n_of` thresholds are bounded by the component count** (note 4). The threshold control is
 *    capped at the current count, and the server refuses anything above it anyway (TC-21e).
 */
import { useState } from 'react';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import type {
  CampaignActivityOption,
  Journey,
  JourneyComponent,
  JourneyTracker,
} from '@reward-portal/shared';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Card, CardBody, CardHeader } from '../../../components/Card';
import { Checkbox } from '../../../components/Checkbox';
import { EmptyState } from '../../../components/EmptyState';
import { Input } from '../../../components/Input';
import { Select } from '../../../components/Select';

export type JourneySelection =
  | { readonly kind: 'tracker'; readonly trackerId: number }
  | { readonly kind: 'component'; readonly trackerId: number; readonly componentId: number }
  | null;

export interface JourneyStepProps {
  readonly journey: Journey | undefined;
  readonly activities: readonly CampaignActivityOption[];
  readonly disabled?: boolean;
  readonly onAddTracker: (name: string) => void;
  readonly onUpdateTracker: (
    trackerId: number,
    input: {
      completionLogic?: 'all' | 'any' | 'n_of';
      completionThreshold?: number | null;
      name?: string;
    },
  ) => void;
  readonly onDeleteTracker: (trackerId: number) => void;
  readonly onAddComponent: (trackerId: number, name: string, activityId: number) => void;
  readonly onUpdateComponent: (
    componentId: number,
    input: { isMandatory?: boolean; sequenceOrder?: number; activityId?: number },
  ) => void;
  readonly onDeleteComponent: (componentId: number) => void;
  readonly onMoveComponent: (trackerId: number, componentId: number, direction: -1 | 1) => void;
  readonly error?: string;
}

export function JourneyStep(props: JourneyStepProps) {
  const { journey, disabled, error } = props;
  const [selection, setSelection] = useState<JourneySelection>(null);
  const [trackerName, setTrackerName] = useState('');

  const trackers = journey?.trackers ?? [];

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,20rem)_1fr]">
      <Card>
        <CardHeader className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800">Journey</h3>
        </CardHeader>
        <CardBody className="grid gap-3">
          {trackers.length === 0 && (
            <p className="text-sm text-slate-500">
              A campaign needs at least one tracker. A tracker groups the steps a customer must
              complete.
            </p>
          )}

          <ul className="grid gap-2">
            {trackers.map((tracker) => (
              <li key={tracker.id}>
                <button
                  type="button"
                  aria-current={
                    selection?.kind === 'tracker' && selection.trackerId === tracker.id
                      ? 'true'
                      : undefined
                  }
                  onClick={() => {
                    setSelection({ kind: 'tracker', trackerId: tracker.id });
                  }}
                  className="flex w-full items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50"
                >
                  <span className="font-medium text-slate-800">{tracker.name}</span>
                  <Badge tone="slate">{describeLogic(tracker)}</Badge>
                </button>

                <ul className="mt-1 grid gap-1 pl-4">
                  {tracker.components.map((component) => (
                    <li key={component.id}>
                      <button
                        type="button"
                        aria-current={
                          selection?.kind === 'component' && selection.componentId === component.id
                            ? 'true'
                            : undefined
                        }
                        onClick={() => {
                          setSelection({
                            kind: 'component',
                            trackerId: tracker.id,
                            componentId: component.id,
                          });
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50"
                      >
                        <GripVertical className="size-3.5 text-slate-400" aria-hidden="true" />
                        <span className="flex-1 truncate">
                          {component.sequenceOrder}. {component.name}
                        </span>
                        {!component.isMandatory && <Badge tone="slate">optional</Badge>}
                        {component.rules.length === 0 && <Badge tone="warning">no rule</Badge>}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>

          <div className="flex items-end gap-2 border-t border-slate-100 pt-3">
            <Input
              label="New tracker"
              hideLabel
              placeholder="Tracker name"
              value={trackerName}
              disabled={disabled}
              containerClassName="flex-1"
              onChange={(event) => {
                setTrackerName(event.target.value);
              }}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={disabled || trackerName.trim() === ''}
              onClick={() => {
                props.onAddTracker(trackerName.trim());
                setTrackerName('');
              }}
            >
              <Plus className="size-4" aria-hidden="true" />
              Add
            </Button>
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-4">
        {error !== undefined && (
          <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        )}
        <SelectionPanel
          {...props}
          selection={selection}
          onClear={() => {
            setSelection(null);
          }}
        />
      </div>
    </div>
  );
}

function describeLogic(tracker: JourneyTracker): string {
  if (tracker.completionLogic === 'n_of') {
    return `any ${String(tracker.completionThreshold ?? 0)} of ${String(tracker.components.length)}`;
  }
  return tracker.completionLogic === 'all' ? 'all steps' : 'any step';
}

interface SelectionPanelProps extends JourneyStepProps {
  readonly selection: JourneySelection;
  readonly onClear: () => void;
}

function SelectionPanel(props: SelectionPanelProps) {
  const { journey, selection } = props;
  if (selection === null || journey === undefined) {
    return (
      <EmptyState
        message="Nothing selected"
        description="Pick a tracker or a component on the left to configure it."
      />
    );
  }

  const tracker = journey.trackers.find((entry) => entry.id === selection.trackerId);
  if (tracker === undefined) {
    return <EmptyState message="Nothing selected" description="That node no longer exists." />;
  }

  if (selection.kind === 'tracker') return <TrackerPanel {...props} tracker={tracker} />;

  const component = tracker.components.find((entry) => entry.id === selection.componentId);
  if (component === undefined) {
    return <EmptyState message="Nothing selected" description="That component no longer exists." />;
  }
  return <ComponentPanel {...props} tracker={tracker} component={component} />;
}

function TrackerPanel({
  tracker,
  disabled,
  activities,
  onUpdateTracker,
  onDeleteTracker,
  onAddComponent,
  onClear,
}: SelectionPanelProps & { tracker: JourneyTracker }) {
  const [componentName, setComponentName] = useState('');
  const [activityId, setActivityId] = useState<string | null>(null);
  const count = tracker.components.length;

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">Tracker · {tracker.name}</h3>
        <Button
          type="button"
          variant="danger"
          size="sm"
          disabled={disabled}
          onClick={() => {
            onDeleteTracker(tracker.id);
            onClear();
          }}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          Remove
        </Button>
      </CardHeader>
      <CardBody className="grid gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Completion logic"
            value={tracker.completionLogic}
            disabled={disabled}
            options={[
              { value: 'all', label: 'All steps must be completed' },
              { value: 'any', label: 'Any one step completes it' },
              { value: 'n_of', label: 'A set number of steps (n of)' },
            ]}
            onChange={(value) => {
              onUpdateTracker(tracker.id, {
                completionLogic: value as 'all' | 'any' | 'n_of',
                completionThreshold: value === 'n_of' ? Math.min(1, Math.max(1, count)) : null,
              });
            }}
          />
          {tracker.completionLogic === 'n_of' && (
            <Input
              type="number"
              min={1}
              max={Math.max(count, 1)}
              label="How many steps"
              hint={`Between 1 and ${String(Math.max(count, 1))} — the number of steps this tracker has.`}
              value={String(tracker.completionThreshold ?? 1)}
              disabled={disabled}
              onChange={(event) => {
                onUpdateTracker(tracker.id, { completionThreshold: Number(event.target.value) });
              }}
            />
          )}
        </div>

        {tracker.completionLogic === 'n_of' && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            A step marked <strong>mandatory</strong> is always required, even here. &ldquo;Any 2 of
            3&rdquo; with a mandatory first step means that step <em>plus</em> one other — not any
            two.
          </p>
        )}

        <div className="grid gap-3 border-t border-slate-100 pt-4">
          <h4 className="text-sm font-semibold text-slate-800">Add a step</h4>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Input
              label="Step name"
              value={componentName}
              disabled={disabled}
              onChange={(event) => {
                setComponentName(event.target.value);
              }}
            />
            <Select
              label="Activity"
              placeholder={activities.length === 0 ? 'Pick merchants in step 2 first' : 'Select…'}
              value={activityId}
              disabled={disabled || activities.length === 0}
              options={activities.map((activity) => ({
                value: String(activity.activityId),
                label: activity.name,
              }))}
              onChange={setActivityId}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={disabled || componentName.trim() === '' || activityId === null}
              onClick={() => {
                if (activityId === null) return;
                onAddComponent(tracker.id, componentName.trim(), Number(activityId));
                setComponentName('');
                setActivityId(null);
              }}
            >
              <Plus className="size-4" aria-hidden="true" />
              Add step
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function ComponentPanel({
  tracker,
  component,
  activities,
  disabled,
  onUpdateComponent,
  onDeleteComponent,
  onMoveComponent,
  onClear,
}: SelectionPanelProps & { tracker: JourneyTracker; component: JourneyComponent }) {
  const index = tracker.components.findIndex((entry) => entry.id === component.id);

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">Step · {component.name}</h3>
        <Button
          type="button"
          variant="danger"
          size="sm"
          disabled={disabled}
          onClick={() => {
            onDeleteComponent(component.id);
            onClear();
          }}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          Remove
        </Button>
      </CardHeader>
      <CardBody className="grid gap-5">
        <Select
          label="Activity"
          value={component.activityId === null ? null : String(component.activityId)}
          disabled={disabled}
          options={activities.map((activity) => ({
            value: String(activity.activityId),
            label: activity.name,
          }))}
          onChange={(value) => {
            onUpdateComponent(component.id, { activityId: Number(value) });
          }}
        />

        <div className="grid gap-2">
          <Checkbox
            label="This step is mandatory"
            checked={component.isMandatory}
            disabled={disabled}
            onChange={(event) => {
              onUpdateComponent(component.id, { isMandatory: event.target.checked });
            }}
          />
          <p className="text-sm text-slate-500">
            A mandatory step must be completed even when the tracker only asks for &ldquo;any n
            of&rdquo; its steps.
          </p>
        </div>

        <div className="grid gap-2">
          <span className="text-sm font-medium text-slate-700">
            Order: {component.sequenceOrder}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={disabled || index <= 0}
              onClick={() => {
                onMoveComponent(tracker.id, component.id, -1);
              }}
            >
              Move up
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={disabled || index < 0 || index >= tracker.components.length - 1}
              onClick={() => {
                onMoveComponent(tracker.id, component.id, 1);
              }}
            >
              Move down
            </Button>
          </div>
          <p className="text-sm text-slate-500">
            Order is how the journey is <em>presented</em>. Customers are not blocked from
            completing a later step first.
          </p>
        </div>

        <p className="text-sm text-slate-500">
          {component.rules.length === 0
            ? 'No rule decides this step yet — add one in step 4. A step with no rule can never complete.'
            : `${String(component.rules.length)} rule(s) decide this step. Their values are set in step 4.`}
        </p>
      </CardBody>
    </Card>
  );
}
