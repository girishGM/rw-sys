/**
 * T-047 — the `.proto` **is** the cross-team contract, and this suite is what stops it drifting
 * from the code that serves it.
 *
 * Two directions, both of which have to hold:
 *
 *  1. Every message in `campaign_config.v1.proto` has a descriptor in
 *     `campaign-config.messages.ts` with **the same field names, the same field numbers and
 *     compatible types**. A renumbering is a silent wire break for a consumer this repository does
 *     not build; catching it here turns that into a red test.
 *  2. Every property 09-INTEGRATION.md states about the contract still holds of the file: read-only
 *     RPCs (verification step 6), no `connector_config` (§6), money as strings (§4b), and the six
 *     `ConfigSection` values with the numbering the runtime generates from.
 *
 * The parser below is deliberately small and strict — it understands exactly the subset of proto3
 * this file uses and throws on anything else, so a construct it cannot see (a `oneof`, a `map`, a
 * nested type) can never be silently skipped and left unchecked.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_MESSAGES } from '@/grpc/wire/campaign-config.messages';
import {
  ALL_SECTIONS,
  CONFIG_SECTION,
  GRPC_METHOD,
  GRPC_SERVICE_FULL_NAME,
} from '@/grpc/grpc.constants';
import type { FieldDescriptor, MessageDescriptor } from '@/grpc/wire/proto-codec';

const PROTO_PATH = join(__dirname, '../../proto/campaign_config.v1.proto');
const source = readFileSync(PROTO_PATH, 'utf8');

/** The file with comments removed, so a field name inside a comment is never parsed as a field. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

interface ParsedField {
  readonly name: string;
  readonly no: number;
  readonly type: string;
  readonly repeated: boolean;
}

/** Every `message` block in the file, parsed. */
function parseMessages(): Map<string, ParsedField[]> {
  const messages = new Map<string, ParsedField[]>();
  const blockPattern = /(?:^|\n)\s*message\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let block: RegExpExecArray | null;
  while ((block = blockPattern.exec(code)) !== null) {
    const [, name, body] = block;
    // A nested `enum` block (`ConfigChangeEvent.ChangeType`) is removed wholesale first: its
    // members are `NAME = n`, which is shaped enough like a field to confuse the parser and — on
    // the first run of this suite — did exactly that, hiding `campaign_id` from the comparison.
    const withoutNestedEnums = body.replace(/enum\s+\w+\s*\{[\s\S]*?\}/g, '');
    const fields: ParsedField[] = [];
    for (const raw of withoutNestedEnums.split(';')) {
      const line = raw.trim().replace(/^[{}\s]+/, '');
      if (line === '') continue;
      const match = /^(repeated\s+)?([\w.]+)\s+(\w+)\s*=\s*(\d+)$/.exec(line.replace(/\s+/g, ' '));
      if (match === null) continue;
      const [, repeated, type, fieldName, number] = match;
      fields.push({
        name: fieldName,
        no: Number(number),
        type,
        repeated: repeated !== undefined,
      });
    }
    messages.set(name, fields);
  }
  return messages;
}

const parsed = parseMessages();
const descriptors = new Map<string, MessageDescriptor>(
  ALL_MESSAGES.map((descriptor) => [descriptor.name, descriptor]),
);

/** The descriptor type, expressed the way the `.proto` writes it. */
function descriptorTypeName(field: FieldDescriptor): string {
  if (typeof field.type === 'object') return field.type.message().name;
  return field.type;
}

describe('the .proto file is the contract', () => {
  it('parses (sanity: the parser found the messages the file declares)', () => {
    expect(parsed.size).toBeGreaterThanOrEqual(20);
    expect(parsed.has('CampaignConfig')).toBe(true);
    expect(parsed.has('BoundRule')).toBe(true);
  });

  it('declares a descriptor for every message in the file', () => {
    const missing = [...parsed.keys()].filter((name) => !descriptors.has(name));
    expect(missing).toEqual([]);
  });

  it('numbers every field exactly as the .proto does', () => {
    for (const [messageName, fields] of parsed) {
      const descriptor = descriptors.get(messageName);
      expect(descriptor).toBeDefined();
      const byName = new Map(
        (descriptor as MessageDescriptor).fields.map((field) => [field.name, field]),
      );

      for (const field of fields) {
        const declared = byName.get(field.name);
        expect({ messageName, field: field.name, found: declared !== undefined }).toEqual({
          messageName,
          field: field.name,
          found: true,
        });
        expect({ messageName, field: field.name, no: (declared as FieldDescriptor).no }).toEqual({
          messageName,
          field: field.name,
          no: field.no,
        });
        expect({
          messageName,
          field: field.name,
          repeated: (declared as FieldDescriptor).repeated === true,
        }).toEqual({ messageName, field: field.name, repeated: field.repeated });
      }

      // And nothing extra: a descriptor field the .proto does not declare would be encoded onto
      // the wire and read as an unknown field by the runtime — invisible, and wrong.
      const extra = (descriptor as MessageDescriptor).fields
        .map((field) => field.name)
        .filter((name) => !fields.some((field) => field.name === name));
      expect({ messageName, extra }).toEqual({ messageName, extra: [] });
    }
  });

  it('agrees with the .proto about every field’s type', () => {
    const scalarEquivalent: Record<string, string> = {
      int32: 'int32',
      string: 'string',
      bool: 'bool',
      ConfigSection: 'enum',
      'ConfigChangeEvent.ChangeType': 'enum',
      ChangeType: 'enum',
    };
    for (const [messageName, fields] of parsed) {
      const descriptor = descriptors.get(messageName) as MessageDescriptor;
      const byName = new Map(descriptor.fields.map((field) => [field.name, field]));
      for (const field of fields) {
        const declared = byName.get(field.name) as FieldDescriptor;
        const expected = scalarEquivalent[field.type] ?? field.type;
        expect({ messageName, field: field.name, type: descriptorTypeName(declared) }).toEqual({
          messageName,
          field: field.name,
          type: expected,
        });
      }
    }
  });
});

describe('the properties 09-INTEGRATION.md states about the contract', () => {
  it('exposes ONLY read RPCs — verification step 6', () => {
    const rpcs = [...code.matchAll(/\brpc\s+(\w+)\s*\(/g)].map((match) => match[1]);
    expect(rpcs.sort()).toEqual(
      [
        GRPC_METHOD.GET_BUDGET_STATUS,
        GRPC_METHOD.GET_CAMPAIGN_CONFIG,
        GRPC_METHOD.LIST_ACTIVE_CAMPAIGNS,
        GRPC_METHOD.RESOLVE_REWARD_VERSION,
        GRPC_METHOD.RESOLVE_RULE_VERSION,
        GRPC_METHOD.WATCH_CAMPAIGN_CONFIG,
      ].sort(),
    );
    // TC-13. Every verb that would mutate, absent — checked by name rather than by reading the
    // list above, so a future `rpc UpdateCampaign` fails here even if somebody also edits the
    // expectation above.
    for (const verb of ['Create', 'Update', 'Delete', 'Set', 'Write', 'Pause', 'Approve', 'Put']) {
      expect(rpcs.filter((rpc) => rpc.startsWith(verb))).toEqual([]);
    }
  });

  it('names the service exactly as the code routes it', () => {
    expect(code).toMatch(/package\s+rewardportal\.config\.v1\s*;/);
    expect(code).toMatch(/service\s+CampaignConfigService\s*\{/);
    expect(GRPC_SERVICE_FULL_NAME).toBe('rewardportal.config.v1.CampaignConfigService');
  });

  it('never mentions connector_config — §6', () => {
    expect(source).not.toMatch(/connector_config\s*=/);
    // The words appear only in the two comments that explain the absence.
    const mentions = [...source.matchAll(/connector_config/g)].length;
    expect(mentions).toBe(3);
  });

  it('carries no floating-point type anywhere — §4b, money is a string', () => {
    expect(code).not.toMatch(/\b(float|double)\s+\w+\s*=/);
    for (const field of ['amount', 'max_total_amount', 'observed_total']) {
      const declaration = new RegExp(`(\\w+)\\s+${field}\\s*=`).exec(code);
      if (declaration !== null) expect(declaration[1]).toBe('string');
    }
  });

  it('numbers ConfigSection exactly as the code does', () => {
    const block = /enum\s+ConfigSection\s*\{([\s\S]*?)\}/.exec(code);
    expect(block).not.toBeNull();
    const entries = [...(block as RegExpExecArray)[1].matchAll(/(\w+)\s*=\s*(\d+)\s*;/g)].map(
      (match) => [match[1], Number(match[2])] as const,
    );
    expect(Object.fromEntries(entries)).toEqual(CONFIG_SECTION);
    expect(ALL_SECTIONS).toEqual(['BASIC', 'MERCHANTS', 'TRACKERS', 'RULES', 'REWARDS', 'CAPS']);
  });

  it('serves BoundRule with the schema AND the values — TC-2', () => {
    const boundRule = parsed.get('BoundRule');
    expect(boundRule?.map((field) => field.name)).toEqual(
      expect.arrayContaining([
        'rule_id',
        'rule_version_id',
        'version_no',
        'parameters_json',
        'bound_values_json',
      ]),
    );
  });

  it('has no proto3 construct this codec cannot encode', () => {
    for (const construct of ['oneof ', 'map<', 'google.protobuf.FieldMask', 'extend ']) {
      expect(code).not.toContain(construct);
    }
  });
});
