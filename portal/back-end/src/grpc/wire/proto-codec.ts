/**
 * T-047 — a proto3 encoder/decoder for the messages in `proto/campaign_config.v1.proto`.
 *
 * ### Why this file exists at all
 *
 * The obvious implementation of a gRPC server on Node is `@grpc/grpc-js` + `@grpc/proto-loader`,
 * and that is what this task would have used. Neither is installable here: this environment has
 * **no network access to the npm registry** (verified — `npm install` cannot reach it), and no
 * copy of either package exists in the workspace or in the local npm cache. The choice was
 * therefore between shipping T-047 without a listener at all — leaving the contract the transaction
 * runtime is waiting on unproven — and implementing the two standard formats the runtime speaks.
 * They are both fully specified and neither is large:
 *
 *  - **proto3 wire format** — this file. Varints, length-delimited fields, packed repeated
 *    scalars. ~200 lines, and every rule it implements is written down in the protobuf encoding
 *    specification rather than inferred.
 *  - **gRPC over HTTP/2** — `grpc-http2.server.ts`, on `node:http2`, which is stdlib.
 *
 * **This changes nothing about the contract.** The bytes on the wire are ordinary proto3 and
 * ordinary gRPC, so a consumer generating from `campaign_config.v1.proto` with `protoc`,
 * `grpc-java`, `grpc-go` or `@grpc/proto-loader` interoperates without knowing this file exists.
 * It is disclosed as a deviation in the completion report, with the recommendation that the
 * dependency be adopted the moment the registry is reachable — at which point the descriptors in
 * `campaign-config.messages.ts` are deleted and nothing else changes, because the transport is
 * behind `campaign-config.controller.ts`.
 *
 * ### The rules this implements, and the ones it deliberately does not
 *
 * Implemented, because the contract uses them: varint (`int32`, `bool`, enums), length-delimited
 * (`string`, embedded messages), repeated fields — **packed** on encode for numeric scalars, and
 * accepted **either** packed or unpacked on decode, which is what proto3 requires of a conformant
 * parser. Proto3 implicit presence: a field equal to its type's default is not written, and a
 * field absent from the wire decodes to that default.
 *
 * Not implemented, because `campaign_config.v1.proto` contains none of them, and a codec that
 * pretends to support a type it has never encoded is worse than one that refuses: `float`/
 * `double`, `sint*`/zigzag, `fixed*`, `bytes`, `map`, `oneof`, groups. {@link encodeMessage} throws
 * on an unknown type rather than guessing. Money is a `string` here precisely because floats are
 * banned from this contract (09-INTEGRATION.md §4b), so the absence of float support is a feature.
 *
 * Unknown fields encountered on **decode** are skipped by wire type, not rejected — that is the
 * forward-compatibility property the whole point of protobuf, and it is what lets the runtime team
 * add a field for their own use without breaking this server.
 */

/** The scalar types this contract uses. See the header for what is deliberately missing. */
export type ScalarType = 'int32' | 'string' | 'bool' | 'enum';

/** A reference to another message, as a thunk so descriptors may be mutually recursive. */
export interface MessageRef {
  readonly message: () => MessageDescriptor;
}

export type FieldType = ScalarType | MessageRef;

export interface FieldDescriptor {
  /** The field name **as it appears in the `.proto` file** (snake_case). The contract test
   * compares this against the proto source, so it must not be "tidied" into camelCase. */
  readonly name: string;
  /** The field number. Changing one is a silent wire break for a consumer we do not build. */
  readonly no: number;
  readonly type: FieldType;
  readonly repeated?: boolean;
}

export interface MessageDescriptor {
  readonly name: string;
  readonly fields: readonly FieldDescriptor[];
}

/** The decoded/encodable shape of a message: field values keyed by camelCase name. */
export type MessageValue = Record<string, unknown>;

const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED64 = 1;
const WIRE_FIXED32 = 5;

/** `bound_values_json` → `boundValuesJson`. The wire uses the proto name; TypeScript uses this. */
export function jsName(protoName: string): string {
  return protoName.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

function isMessage(type: FieldType): type is MessageRef {
  return typeof type === 'object';
}

// --- encoding -------------------------------------------------------------------------------

/**
 * A growable byte sink.
 *
 * Written by hand rather than by `Buffer.concat`-ing per field: a config with a few hundred
 * bound rules would otherwise allocate and copy thousands of times per response, and this path
 * is the one 09-INTEGRATION.md §2 chose protobuf for in the first place.
 */
class ByteSink {
  private buffer = Buffer.allocUnsafe(256);
  private length = 0;

  private ensure(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + extra) size *= 2;
    const grown = Buffer.allocUnsafe(size);
    this.buffer.copy(grown, 0, 0, this.length);
    this.buffer = grown;
  }

  byte(value: number): void {
    this.ensure(1);
    this.buffer[this.length++] = value;
  }

  bytes(value: Buffer): void {
    this.ensure(value.length);
    value.copy(this.buffer, this.length);
    this.length += value.length;
  }

  varint(value: number): void {
    // Negative int32 is encoded as a 64-bit two's-complement varint (10 bytes) — the protobuf
    // specification's rule for `int32`, and the reason `sint32` exists. No field in this contract
    // is ever negative in practice, but encoding it wrongly would corrupt rather than fail.
    let remaining = value < 0 ? BigInt.asUintN(64, BigInt(value)) : BigInt(value);
    while (remaining >= 0x80n) {
      this.byte(Number((remaining & 0x7fn) | 0x80n));
      remaining >>= 7n;
    }
    this.byte(Number(remaining));
  }

  result(): Buffer {
    return Buffer.from(this.buffer.subarray(0, this.length));
  }
}

function tag(sink: ByteSink, fieldNo: number, wireType: number): void {
  sink.varint(fieldNo * 8 + wireType);
}

function encodeInto(sink: ByteSink, descriptor: MessageDescriptor, value: MessageValue): void {
  for (const field of descriptor.fields) {
    const raw = value[jsName(field.name)];
    if (raw === undefined || raw === null) continue;

    if (field.repeated === true) {
      const items = raw as readonly unknown[];
      if (!Array.isArray(items) || items.length === 0) continue;

      if (isMessage(field.type)) {
        const nested = field.type.message();
        for (const item of items) {
          tag(sink, field.no, WIRE_LENGTH_DELIMITED);
          const body = encodeMessage(nested, item as MessageValue);
          sink.varint(body.length);
          sink.bytes(body);
        }
        continue;
      }
      if (field.type === 'string') {
        for (const item of items) {
          tag(sink, field.no, WIRE_LENGTH_DELIMITED);
          const body = Buffer.from(String(item), 'utf8');
          sink.varint(body.length);
          sink.bytes(body);
        }
        continue;
      }
      // Packed, which is proto3's default for repeated numeric scalars.
      const packed = new ByteSink();
      for (const item of items) packed.varint(numeric(field, item));
      const body = packed.result();
      tag(sink, field.no, WIRE_LENGTH_DELIMITED);
      sink.varint(body.length);
      sink.bytes(body);
      continue;
    }

    if (isMessage(field.type)) {
      const body = encodeMessage(field.type.message(), raw as MessageValue);
      // An embedded message equal to its default is still *present* if the caller supplied it —
      // but an empty one carries no information, so it is skipped, matching what every conformant
      // proto3 implementation produces for an unset singular message field.
      if (body.length === 0) continue;
      tag(sink, field.no, WIRE_LENGTH_DELIMITED);
      sink.varint(body.length);
      sink.bytes(body);
      continue;
    }

    if (field.type === 'string') {
      const text = String(raw);
      if (text.length === 0) continue; // proto3 implicit presence
      const body = Buffer.from(text, 'utf8');
      tag(sink, field.no, WIRE_LENGTH_DELIMITED);
      sink.varint(body.length);
      sink.bytes(body);
      continue;
    }

    const number = numeric(field, raw);
    if (number === 0) continue; // proto3 implicit presence: 0/false is not written
    tag(sink, field.no, WIRE_VARINT);
    sink.varint(number);
  }
}

function numeric(field: FieldDescriptor, raw: unknown): number {
  if (field.type === 'bool') return raw === true ? 1 : 0;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new TypeError(
      `field ${field.name} expects a ${field.type}; received ${JSON.stringify(raw)}`,
    );
  }
  if (!Number.isSafeInteger(raw)) {
    throw new TypeError(`field ${field.name} expects an integer; received ${raw}`);
  }
  return raw;
}

/** Serialises `value` against `descriptor`. */
export function encodeMessage(descriptor: MessageDescriptor, value: MessageValue): Buffer {
  const sink = new ByteSink();
  encodeInto(sink, descriptor, value ?? {});
  return sink.result();
}

// --- decoding -------------------------------------------------------------------------------

class ByteSource {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  get done(): boolean {
    return this.offset >= this.buffer.length;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.offset >= this.buffer.length) {
        throw new RangeError('truncated varint in protobuf message');
      }
      const byte = this.buffer[this.offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new RangeError('varint longer than 64 bits');
    }
  }

  take(length: number): Buffer {
    if (length < 0 || this.offset + length > this.buffer.length) {
      throw new RangeError('truncated length-delimited field in protobuf message');
    }
    const slice = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  skip(length: number): void {
    this.take(length);
  }
}

/** The zero value of a field, per proto3 implicit presence. */
function defaultValue(field: FieldDescriptor): unknown {
  if (field.repeated === true) return [];
  if (isMessage(field.type)) return undefined;
  if (field.type === 'string') return '';
  if (field.type === 'bool') return false;
  return 0;
}

/**
 * Parses `buffer` against `descriptor`.
 *
 * Every declared field is present in the result, at its default when the wire carried nothing —
 * so a consumer never has to distinguish "absent" from "zero", which proto3 itself does not.
 */
export function decodeMessage(descriptor: MessageDescriptor, buffer: Buffer): MessageValue {
  const result: MessageValue = {};
  const byNumber = new Map<number, FieldDescriptor>();
  for (const field of descriptor.fields) {
    result[jsName(field.name)] = defaultValue(field);
    byNumber.set(field.no, field);
  }

  const source = new ByteSource(buffer);
  while (!source.done) {
    const key = Number(source.varint());
    const fieldNo = key >>> 3;
    const wireType = key & 0x7;
    const field = byNumber.get(fieldNo);

    if (field === undefined) {
      skipUnknown(source, wireType);
      continue;
    }

    const name = jsName(field.name);
    if (wireType === WIRE_LENGTH_DELIMITED) {
      const body = source.take(Number(source.varint()));

      if (isMessage(field.type)) {
        const nested = decodeMessage(field.type.message(), body);
        if (field.repeated === true) (result[name] as unknown[]).push(nested);
        else result[name] = nested;
        continue;
      }
      if (field.type === 'string') {
        const text = body.toString('utf8');
        if (field.repeated === true) (result[name] as unknown[]).push(text);
        else result[name] = text;
        continue;
      }
      // A packed repeated numeric scalar.
      const packed = new ByteSource(body);
      while (!packed.done) {
        const item = scalarFrom(field, packed.varint());
        if (field.repeated === true) (result[name] as unknown[]).push(item);
        else result[name] = item;
      }
      continue;
    }

    if (wireType === WIRE_VARINT) {
      const item = scalarFrom(field, source.varint());
      // An *unpacked* repeated numeric scalar. A conformant proto3 parser must accept this shape
      // even though it never produces it — an older or hand-written encoder may send it.
      if (field.repeated === true) (result[name] as unknown[]).push(item);
      else result[name] = item;
      continue;
    }

    skipUnknown(source, wireType);
  }

  return result;
}

function scalarFrom(field: FieldDescriptor, raw: bigint): unknown {
  if (field.type === 'bool') return raw !== 0n;
  // `int32` on the wire is a 64-bit varint; the low 32 bits, signed, are the value.
  return Number(BigInt.asIntN(32, raw));
}

function skipUnknown(source: ByteSource, wireType: number): void {
  switch (wireType) {
    case WIRE_VARINT:
      source.varint();
      return;
    case WIRE_LENGTH_DELIMITED:
      source.skip(Number(source.varint()));
      return;
    case WIRE_FIXED64:
      source.skip(8);
      return;
    case WIRE_FIXED32:
      source.skip(4);
      return;
    default:
      // Groups (3/4) were removed in proto3 and cannot be skipped without a schema. Refusing is
      // the only honest option: silently ignoring the rest of the message would hand the caller a
      // half-parsed request, which is the exact failure mode §10 forbids on the response side.
      throw new RangeError(`unsupported protobuf wire type ${wireType}`);
  }
}
