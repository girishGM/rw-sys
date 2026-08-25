/**
 * T-032 — the `connectorConfig` key/value editor (04-FRONTEND.md §4: "Reward system + connector
 * config + policies").
 *
 * Write-only, by design: the server never returns the plaintext or the ciphertext, only a masked
 * form (`{"apiKey": "••••1234"}`, implementation note 4) — there is nothing to pre-fill this
 * editor with even on an edit screen, so every field here starts empty and, on submit, **replaces
 * the whole `connectorConfig`** rather than patching it (matching `RewardsService.update`'s own
 * "no partial merge" contract). Leaving every row blank omits `connectorConfig` from the request
 * entirely, which leaves the stored value untouched.
 */
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';

export interface ConnectorConfigEntry {
  readonly key: string;
  readonly value: string;
}

export interface ConnectorConfigEditorProps {
  entries: readonly ConnectorConfigEntry[];
  onChange: (entries: ConnectorConfigEntry[]) => void;
  disabled?: boolean;
}

export function ConnectorConfigEditor({ entries, onChange, disabled }: ConnectorConfigEditorProps) {
  function updateEntry(index: number, patch: Partial<ConnectorConfigEntry>): void {
    onChange(entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  }

  function removeEntry(index: number): void {
    onChange(entries.filter((_entry, i) => i !== index));
  }

  function addEntry(): void {
    onChange([...entries, { key: '', value: '' }]);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">
          Connector config
          <span className="ml-2 font-normal text-slate-400">
            third-party credentials — encrypted at rest, never shown again
          </span>
        </h3>
        <Button type="button" variant="secondary" size="sm" onClick={addEntry} disabled={disabled}>
          <Plus className="size-4" aria-hidden="true" />
          Add field
        </Button>
      </div>

      {entries.length === 0 && (
        <p className="text-sm text-slate-500">No connector configuration set.</p>
      )}

      {entries.map((entry, index) => (
        <div key={index} className="grid grid-cols-12 items-end gap-2">
          <div className="col-span-5">
            <Input
              label="Key"
              hideLabel
              placeholder="apiKey"
              value={entry.key}
              onChange={(event) => updateEntry(index, { key: event.target.value })}
              disabled={disabled}
            />
          </div>
          <div className="col-span-6">
            <Input
              label="Value"
              hideLabel
              type="password"
              placeholder="sk_live_..."
              value={entry.value}
              onChange={(event) => updateEntry(index, { value: event.target.value })}
              disabled={disabled}
            />
          </div>
          <div className="col-span-1 flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => removeEntry(index)}
              disabled={disabled}
              aria-label="Remove field"
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
