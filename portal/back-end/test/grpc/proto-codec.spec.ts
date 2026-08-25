/**
 * T-047 — the proto3 codec, against **hand-computed wire bytes**.
 *
 * A round-trip test alone would pass for a codec that is self-consistently wrong, and a
 * self-consistently wrong codec is the worst possible outcome for a cross-team contract: every test
 * here would be green and the transaction runtime, generating from the same `.proto` with `protoc`,
 * would read garbage. So the assertions below are byte strings derived from the protobuf encoding
 * specification by hand — tag = `field_number << 3 | wire_type`, base-128 varints, length-delimited
 * payloads — and the round-trip tests sit on top of that rather than instead of it.
 */
import {
  decodeMessage,
  encodeMessage,
  jsName,
  type MessageDescriptor,
} from '@/grpc/wire/proto-codec';
import {
  BoundRuleMessage,
  CampaignConfigMessage,
  GetCampaignConfigRequestMessage,
  MoneyMessage,
} from '@/grpc/wire/campaign-config.messages';

const hex = (buffer: Buffer): string => buffer.toString('hex');

describe('proto-codec — wire format', () => {
  it('encodes two string fields with the tags and lengths the specification requires', () => {
    // Money { amount = "10.50" (field 1), currency = "MYR" (field 2) }
    //   0a       field 1, wire type 2   (1 << 3 | 2)
    //   05       length 5
    //   31 30 2e 35 30   "10.50"
    //   12       field 2, wire type 2   (2 << 3 | 2)
    //   03       length 3
    //   4d 59 52 "MYR"
    const encoded = encodeMessage(MoneyMessage, { amount: '10.50', currency: 'MYR' });
    expect(hex(encoded)).toBe('0a05' + '31302e3530' + '1203' + '4d5952');
  });

  it('encodes an int32 as a base-128 varint', () => {
    // GetCampaignConfigRequest { tenant_id = 300 }  →  08 (field 1, varint), then 300 = ac 02
    const encoded = encodeMessage(GetCampaignConfigRequestMessage, {
      tenantId: 300,
      campaignCode: '',
      etag: '',
      sections: [],
    });
    expect(hex(encoded)).toBe('08ac02');
  });

  it('packs a repeated enum, as proto3 requires for numeric scalars', () => {
    // sections is field 4: tag = 4 << 3 | 2 = 0x22, length 2, then the two varints 01 and 05.
    const encoded = encodeMessage(GetCampaignConfigRequestMessage, {
      tenantId: 0,
      campaignCode: '',
      etag: '',
      sections: [1, 5],
    });
    expect(hex(encoded)).toBe('2202' + '0105');
  });

  it('omits every field equal to its type default (proto3 implicit presence)', () => {
    const encoded = encodeMessage(GetCampaignConfigRequestMessage, {
      tenantId: 0,
      campaignCode: '',
      etag: '',
      sections: [],
    });
    expect(encoded).toHaveLength(0);
  });

  it('encodes a bool and a high field number correctly', () => {
    // not_modified is field 16: tag = 16 << 3 | 0 = 128 → varint 80 01, then the value 01.
    const encoded = encodeMessage(CampaignConfigMessage, { notModified: true });
    expect(hex(encoded)).toBe('8001' + '01');
  });

  it('encodes an embedded message as a length-delimited field', () => {
    // budget is field 8: tag = 8 << 3 | 2 = 0x42, then the **byte length of the nested Money
    // message** — 3 for `0a 01 35` ("5") plus 5 for `12 03 4d 59 52` ("MYR") = 8. (This
    // expectation was wrong on the first pass and the codec was right, which is the argument for
    // hand-computed bytes rather than a round trip: a round trip agrees with a mistake.)
    const encoded = encodeMessage(CampaignConfigMessage, {
      budget: { amount: '5', currency: 'MYR' },
    });
    expect(hex(encoded)).toBe('42' + '08' + '0a0135' + '1203' + '4d5952');
  });

  it('encodes multi-byte UTF-8 by byte length, not character count', () => {
    const encoded = encodeMessage(MoneyMessage, { amount: '', currency: '€' });
    // "€" is three bytes in UTF-8 (e2 82 ac); the length prefix must say 3, not 1.
    expect(hex(encoded)).toBe('1203' + 'e282ac');
    expect(decodeMessage(MoneyMessage, encoded)['currency']).toBe('€');
  });

  it('encodes a negative int32 as a 10-byte two’s-complement varint', () => {
    // Not reachable from any field this contract populates, but encoding it wrongly would corrupt
    // rather than fail, so it is pinned.
    const encoded = encodeMessage(GetCampaignConfigRequestMessage, { tenantId: -1 });
    expect(hex(encoded)).toBe('08' + 'ffffffffffffffffff01');
    expect(decodeMessage(GetCampaignConfigRequestMessage, encoded)['tenantId']).toBe(-1);
  });
});

describe('proto-codec — decoding', () => {
  it('accepts an UNPACKED repeated numeric field, which a conformant parser must', () => {
    // Some encoders (and hand-written clients) emit repeated scalars one tag at a time.
    const unpacked = Buffer.from('2001' + '2005', 'hex');
    const decoded = decodeMessage(GetCampaignConfigRequestMessage, unpacked);
    expect(decoded['sections']).toEqual([1, 5]);
  });

  it('skips unknown fields of every wire type rather than failing', () => {
    // A newer client sending fields this build does not know: varint (field 99), length-delimited
    // (field 100), fixed64 (field 101) and fixed32 (field 102), around a field we do know.
    const bytes = Buffer.concat([
      Buffer.from('08' + '07', 'hex'), // tenant_id = 7
      Buffer.from('98060f', 'hex'), // field 99, varint 15
      Buffer.from('a20602' + 'abcd', 'hex'), // field 100, length 2
      Buffer.from('a9060000000000000000', 'hex'), // field 101, fixed64
      Buffer.from('b50600000000', 'hex'), // field 102, fixed32
    ]);
    const decoded = decodeMessage(GetCampaignConfigRequestMessage, bytes);
    expect(decoded['tenantId']).toBe(7);
  });

  it('returns the type default for every field the wire did not carry', () => {
    const decoded = decodeMessage(BoundRuleMessage, Buffer.alloc(0));
    expect(decoded).toEqual({
      ruleId: 0,
      ruleVersionId: 0,
      versionNo: 0,
      ruleCode: '',
      expression: '',
      parametersJson: '',
      boundValuesJson: '',
      trackerComponentId: 0,
      status: '',
    });
  });

  it('refuses a truncated message rather than returning half of one', () => {
    // Length prefix says 9 bytes; only 2 follow. §10's "complete or an error" applies to what this
    // service *reads* as much as to what it writes.
    expect(() => decodeMessage(MoneyMessage, Buffer.from('0a09' + '3130', 'hex'))).toThrow(
      /truncated/,
    );
  });

  it('refuses a group wire type, which proto3 removed', () => {
    expect(() => decodeMessage(MoneyMessage, Buffer.from('0b', 'hex'))).toThrow(
      /unsupported protobuf wire type/,
    );
  });
});

describe('proto-codec — round trips', () => {
  it('round-trips a fully populated CampaignConfig', () => {
    const original = {
      campaignId: 42,
      campaignCode: 'T047-CAMPAIGN',
      tenantId: 7,
      countryId: 3,
      status: 'paused',
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-12-31T00:00:00.000Z',
      budget: { amount: '500000.00', currency: 'MYR' },
      maxParticipants: 1000,
      merchants: [
        {
          merchantId: 1,
          merchantCode: 'M1',
          name: 'Merchant One',
          status: 'active',
          activities: [{ activityId: 9, activityCode: 'A9', name: 'Spend' }],
        },
      ],
      trackers: [
        {
          trackerId: 5,
          trackerCode: 'TRK5',
          name: 'Tracker',
          completionLogic: 'all',
          completionThreshold: 2,
          status: 'active',
          components: [
            {
              componentId: 11,
              componentCode: 'CMP11',
              name: 'Component',
              activityId: 9,
              sequenceOrder: 1,
              isMandatory: true,
              status: 'active',
            },
          ],
        },
      ],
      rules: [
        {
          ruleId: 2,
          ruleVersionId: 33,
          versionNo: 3,
          ruleCode: 'MIN_SPEND',
          expression: 'amount >= :minSpend',
          parametersJson: '{"fields":[]}',
          boundValuesJson: '{"minSpend":150}',
          trackerComponentId: 11,
          status: 'active',
        },
      ],
      rewards: [
        {
          rewardId: 4,
          rewardVersionId: 44,
          versionNo: 2,
          systemCode: 'PTS',
          rewardType: 'points',
          deliveryMode: 'instant',
          policiesJson: '{"rate":1}',
          unitType: 'points',
          unitCode: 'PTS',
          level: 'tracker',
          refId: 5,
          status: 'active',
        },
      ],
      caps: [
        {
          capClass: 'budget',
          scopeLevel: 'campaign',
          scopeRefId: 0,
          periodType: 'lifetime',
          periodValue: 0,
          windowStartTime: '',
          windowEndTime: '',
          periodTimezone: 'Asia/Kuala_Lumpur',
          unitType: 'currency',
          unitCode: 'MYR',
          rewardType: '',
          maxTotalAmount: '500000.00',
          maxOccurrences: 0,
          maxCustomers: 0,
          onBreach: 'pause_campaign',
          warnAtPercent: 80,
        },
      ],
      etag: 'abc',
      configHash: 'def',
      notModified: false,
      servedAt: '2026-08-19T10:00:00.000Z',
      sectionsReturned: [1, 2, 3, 4, 5, 6],
      sectionsOmitted: [],
    };

    const decoded = decodeMessage(
      CampaignConfigMessage,
      encodeMessage(CampaignConfigMessage, original),
    );
    // `notModified: false` and empty arrays are type defaults; they decode back to themselves.
    expect(decoded).toEqual(original);
  });

  it('round-trips every declared field of every message with a distinctive value', () => {
    const descriptors: MessageDescriptor[] = [
      MoneyMessage,
      BoundRuleMessage,
      GetCampaignConfigRequestMessage,
    ];
    for (const descriptor of descriptors) {
      const value: Record<string, unknown> = {};
      for (const [index, field] of descriptor.fields.entries()) {
        const name = jsName(field.name);
        if (field.repeated === true) value[name] = field.type === 'string' ? ['x'] : [index + 1];
        else if (field.type === 'string') value[name] = `v${index}`;
        else if (field.type === 'bool') value[name] = true;
        else if (typeof field.type === 'object') continue;
        else value[name] = index + 1;
      }
      const decoded = decodeMessage(descriptor, encodeMessage(descriptor, value));
      for (const key of Object.keys(value)) {
        expect({ message: descriptor.name, key, value: decoded[key] }).toEqual({
          message: descriptor.name,
          key,
          value: value[key],
        });
      }
    }
  });
});

describe('proto-codec — misuse', () => {
  it('refuses a non-integer where the schema says int32', () => {
    expect(() => encodeMessage(GetCampaignConfigRequestMessage, { tenantId: 1.5 })).toThrow(
      /expects an integer/,
    );
  });

  it('refuses a string where the schema says int32', () => {
    expect(() => encodeMessage(GetCampaignConfigRequestMessage, { tenantId: 'seven' })).toThrow(
      /expects a int32/,
    );
  });

  it('maps snake_case proto names to camelCase TypeScript names', () => {
    expect(jsName('bound_values_json')).toBe('boundValuesJson');
    expect(jsName('etag')).toBe('etag');
    expect(jsName('tracker_component_id')).toBe('trackerComponentId');
  });
});
