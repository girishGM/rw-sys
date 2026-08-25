/**
 * T-018 — the browser half of the ECDH handshake (07-DATA-PROTECTION.md §5).
 *
 * This file holds every call into `SubtleCrypto` and nothing else, so the one property the whole
 * design rests on can be checked by reading forty lines rather than four hundred:
 *
 * > **The private key is generated with `extractable: false`, and the derived AES key with
 * > `extractable: false`.** Neither can be read out of the browser by JavaScript — including by
 * > injected script — because `exportKey` throws on a non-extractable key. There is no code path
 * > in this application that puts key material into a variable, a cookie, `localStorage` or
 * > `sessionStorage` (AGENT-PROTOCOL R5, T-018 TC-2 and TC-23).
 *
 * ## What that does and does not buy — read this before quoting it at anyone
 *
 * Non-extractability stops the key being **stolen and used elsewhere**: exfiltrated to an
 * attacker's server, replayed from another browser, recovered from a heap dump. It does **not**
 * stop the key being **used in place**. A script running in the page can call `encryptWithKey`
 * with the same `CryptoKey` handle the application uses and get the same answer. Payload
 * encryption is defence against the network path — TLS-terminating proxies, logging middleboxes,
 * hop-by-hop capture — and is not, and cannot be, defence against XSS. The controls for XSS are
 * the strict CSP and the httpOnly cookies in 02-SECURITY.md.
 *
 * ## The one place raw secret bytes exist, and why it is unavoidable
 *
 * `deriveTransportKey` calls `deriveBits` to get the ECDH shared secret and then imports it as an
 * HKDF key. Those 32 bytes are a JS `ArrayBuffer` for the duration of two `await`s. WebCrypto
 * offers no way to chain ECDH into HKDF without them: `deriveKey` can produce an AES key directly
 * from ECDH, but that skips the HKDF step 07-DATA-PROTECTION.md §5 specifies — and skipping it
 * would mean feeding a curve point's X coordinate, which is structured and biased, straight to
 * AES. The specified derivation wins; the transient buffer is a documented, accepted limitation
 * rather than an oversight. It is zero-filled as soon as it has been imported.
 *
 * ## The wire format is the raw SEC1 point, not SPKI
 *
 * `exportKey('raw', …)` on a P-256 public key gives `0x04 || X || Y`, 65 bytes — exactly what
 * Node's `crypto.createECDH('prime256v1').getPublicKey()` produces and consumes. Neither side
 * needs an ASN.1 encoder and there is no format to negotiate.
 */

/** P-256, the curve 07-DATA-PROTECTION.md §5 names. */
const CURVE = 'P-256';

/** `0x04 || X || Y`. */
export const UNCOMPRESSED_POINT_BYTES = 65;

/**
 * HKDF `info`. **Must match `HKDF_INFO` in `back-end/src/common/transport-crypto/
 * handshake.service.ts` byte for byte** — if the two ever diverge, both sides derive a key
 * happily and every payload fails its tag check. `transportCrypto.spec.ts` asserts the derived
 * key equals the one Node's implementation produces, which is what turns that from a comment
 * into a test.
 */
export const HKDF_INFO = 'reward-portal/transport/v1/aes-256-gcm';

/** AES-256. */
export const TRANSPORT_KEY_BITS = 256;

/** 96-bit IV — the GCM-native size. */
export const IV_BYTES = 12;

/** 128-bit GCM authentication tag. */
export const TAG_BYTES = 16;

/** A freshly generated ephemeral keypair. The private half never leaves this object. */
export interface EcdhKeyPair {
  /** Non-extractable. `exportKey` on this throws — that is the point (TC-2). */
  readonly privateKey: CryptoKey;
  /** Base64 of the 65-byte uncompressed point, for the `X-Transport-Public-Key` header. */
  readonly publicKeyBase64: string;
}

/**
 * Generates the per-login ECDH keypair.
 *
 * `extractable: false` applies to the **private** key. The WebCrypto specification always makes
 * the public half of a generated pair extractable regardless of this argument, which is what lets
 * the line below export it — so the one call is both "the private key is unreadable" and "the
 * public key is sendable", with no second, laxer generation anywhere.
 */
export async function generateEcdhKeyPair(subtle: SubtleCrypto): Promise<EcdhKeyPair> {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: CURVE }, false, [
    'deriveBits',
  ])) as CryptoKeyPair;

  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  if (raw.byteLength !== UNCOMPRESSED_POINT_BYTES) {
    throw new Error(
      `WebCrypto produced a ${raw.byteLength}-byte P-256 public key; expected ` +
        `${UNCOMPRESSED_POINT_BYTES}. Refusing to hand the server something it cannot read.`,
    );
  }

  return { privateKey: pair.privateKey, publicKeyBase64: toBase64(raw) };
}

/**
 * ECDH → HKDF-SHA256 → a non-extractable AES-256-GCM key.
 *
 * The salt is `clientPublicKey || serverPublicKey`, in that fixed order, matching
 * `deriveTransportKey` on the server. It binds the key to *this exact exchange*: a recorded
 * handshake replayed with one public key substituted derives a different key, and every payload
 * under it then fails its tag check rather than being silently accepted.
 */
export async function deriveTransportKey(
  subtle: SubtleCrypto,
  privateKey: CryptoKey,
  clientPublicKeyBase64: string,
  serverPublicKeyBase64: string,
): Promise<CryptoKey> {
  const clientPoint = fromBase64(clientPublicKeyBase64);
  const serverPoint = fromBase64(serverPublicKeyBase64);
  if (serverPoint.byteLength !== UNCOMPRESSED_POINT_BYTES || serverPoint[0] !== 0x04) {
    throw new Error('The server public key is not an uncompressed P-256 point.');
  }

  const serverPublicKey = await subtle.importKey(
    'raw',
    // The `Uint8Array` view, not `.buffer`. Both are legal `BufferSource`s, but a raw
    // `ArrayBuffer` crossing a realm boundary — a jsdom test, an iframe, a worker — fails
    // `instanceof ArrayBuffer` in some implementations, while a typed array is recognised by its
    // internal type tag and does not. A copy, so nothing here aliases a buffer we later wipe.
    serverPoint.slice(),
    { name: 'ECDH', namedCurve: CURVE },
    false,
    [],
  );

  // The one place raw secret bytes exist — see this file's header.
  const shared = new Uint8Array(
    await subtle.deriveBits(
      { name: 'ECDH', public: serverPublicKey },
      privateKey,
      TRANSPORT_KEY_BITS,
    ),
  );

  try {
    const hkdfKey = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);

    const salt = new Uint8Array(clientPoint.byteLength + serverPoint.byteLength);
    salt.set(clientPoint, 0);
    salt.set(serverPoint, clientPoint.byteLength);

    return await subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(HKDF_INFO) },
      hkdfKey,
      { name: 'AES-GCM', length: TRANSPORT_KEY_BITS },
      // extractable: false — TC-23. The key exists only as a handle.
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    shared.fill(0);
  }
}

/** Ciphertext and tag, separated the way the `{ iv, tag, ct }` envelope carries them. */
export interface SealedBytes {
  readonly iv: Uint8Array;
  readonly tag: Uint8Array;
  readonly ct: Uint8Array;
}

/**
 * AES-256-GCM with a fresh random IV and the given additional authenticated data.
 *
 * WebCrypto returns ciphertext and tag concatenated; Node's API keeps them apart, and the
 * envelope 07-DATA-PROTECTION.md §5 specifies has separate `tag` and `ct` fields. The split
 * happens here, once, rather than at each call site.
 */
export async function encryptWithKey(
  crypto: Crypto,
  key: CryptoKey,
  plaintext: Uint8Array,
  additionalData: Uint8Array,
): Promise<SealedBytes> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData, tagLength: TAG_BYTES * 8 },
      key,
      plaintext,
    ),
  );

  return {
    iv,
    ct: sealed.slice(0, sealed.byteLength - TAG_BYTES),
    tag: sealed.slice(sealed.byteLength - TAG_BYTES),
  };
}

/**
 * The inverse. Throws — WebCrypto raises an `OperationError` — when the tag does not verify,
 * which is what a tampered payload, a wrong key or mismatched AAD all produce.
 */
export async function decryptWithKey(
  subtle: SubtleCrypto,
  key: CryptoKey,
  sealed: SealedBytes,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  const joined = new Uint8Array(sealed.ct.byteLength + sealed.tag.byteLength);
  joined.set(sealed.ct, 0);
  joined.set(sealed.tag, sealed.ct.byteLength);

  return new Uint8Array(
    await subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.iv, additionalData, tagLength: TAG_BYTES * 8 },
      key,
      joined,
    ),
  );
}

// --- base64 --------------------------------------------------------------------------------

/**
 * `Uint8Array` → standard base64.
 *
 * Chunked rather than `String.fromCharCode(...bytes)`: spreading a large array into a call
 * blows the argument-count limit, and a payload of a few hundred kilobytes is entirely ordinary
 * for this API (the body limit is 1 MB).
 */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

/** Standard base64 → `Uint8Array`. Throws on anything that is not base64. */
export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
