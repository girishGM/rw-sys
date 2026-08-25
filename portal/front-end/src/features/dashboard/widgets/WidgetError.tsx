/**
 * T-023 — the one error tile every widget (and `WidgetBoundary`) renders (TC-11: "that tile
 * shows an error; the rest still render"). `role="alert"` so assistive tech hears the failure
 * without the page needing to move focus to it.
 */
import { AlertTriangle } from 'lucide-react';
import { Card, CardBody } from '../../../components/Card';

export function WidgetErrorTile({ label }: { label: string }) {
  return (
    <Card>
      <CardBody>
        <div role="alert" className="flex items-center gap-2 text-sm text-danger-700">
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          <span>Couldn&apos;t load {label}.</span>
        </div>
      </CardBody>
    </Card>
  );
}
