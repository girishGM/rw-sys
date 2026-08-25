/**
 * T-018 unit-test support — the pieces every transport-crypto spec needs.
 *
 * Two things are deliberately **real** rather than stubbed:
 *
 *  - `FieldCryptoService` over T-016's in-memory test registry. `HandshakeService` wraps the
 *    derived key with it, and a hand-written double would let both sides agree on a convention
 *    the production crypto does not implement — the same argument
 *    `test/auth/support/email-crypto.ts` makes for T-056, and it costs no I/O.
 *  - `sealEnvelope`/`openEnvelope`. A test that reimplements AES-GCM to check AES-GCM proves
 *    nothing; the specs seal with the production codec and assert on what the production reader
 *    does with it.
 *
 * The store is in-memory, because the branch coverage this task needs includes "the session was
 * revoked between issuance and the write", which no real database will produce on demand.
 */
import { FieldCryptoService } from '@/common/crypto';
import { HandshakeService } from '@/common/transport-crypto/handshake.service';
import type { SessionTransportKeyStore } from '@/common/transport-crypto/session-transport-key.repository';
import { buildDefaultRegistry } from '../../crypto/support/keys';

/** A session id shaped like `gen_random_uuid()`'s output. */
export const SESSION_ID = '3f6a1c88-3f2b-4a1e-9d21-6b0a7c9e5d44';
export const OTHER_SESSION_ID = '9c2e5a71-77dd-4a6e-8f0b-1a2b3c4d5e6f';
export const CORRELATION_ID = 'corr-0123456789abcdef';

/** In-memory `SessionTransportKeyStore`. Every branch of the port is reachable from here. */
export class FakeTransportKeyStore implements SessionTransportKeyStore {
  readonly keys = new Map<string, string>();
  /** Sessions this store considers inactive — `store()` and `find()` both refuse them. */
  readonly inactive = new Set<string>();
  /** Session → user, so `clearForUser` can be exercised without a database. */
  readonly owners = new Map<string, number>();
  /** Set to make every method reject, for the "a database error must not fail login" branch. */
  failure: Error | null = null;

  async store(sessionId: string, ciphertext: string): Promise<boolean> {
    if (this.failure !== null) throw this.failure;
    if (this.inactive.has(sessionId)) return false;
    this.keys.set(sessionId, ciphertext);
    return true;
  }

  async find(sessionId: string): Promise<string | null> {
    if (this.failure !== null) throw this.failure;
    if (this.inactive.has(sessionId)) return null;
    return this.keys.get(sessionId) ?? null;
  }

  async clearForSession(sessionId: string): Promise<number> {
    return this.keys.delete(sessionId) ? 1 : 0;
  }

  async clearForUser(userId: number): Promise<number> {
    let cleared = 0;
    for (const [sessionId, owner] of this.owners) {
      if (owner === userId && this.keys.delete(sessionId)) cleared += 1;
    }
    return cleared;
  }
}

export interface HandshakeHarness {
  handshake: HandshakeService;
  store: FakeTransportKeyStore;
  fieldCrypto: FieldCryptoService;
}

/** A `HandshakeService` over the real field crypto and an in-memory store. */
export async function buildHandshake(): Promise<HandshakeHarness> {
  const registry = await buildDefaultRegistry();
  const fieldCrypto = new FieldCryptoService(registry);
  const store = new FakeTransportKeyStore();
  return { handshake: new HandshakeService(store, fieldCrypto), store, fieldCrypto };
}
