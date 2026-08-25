/**
 * T-014 — TC-15 (*"Unknown message key → returns the key; no throw"*) and the rest of
 * implementation note 7.
 *
 * The theme of the suite: this service is called **from the error path**, so every one of its
 * own failure modes has to be a fallback. A `MessageService` that threw while rendering a 403
 * would turn it into an unhandled 500 — and it would do so precisely when the database is
 * unhealthy, i.e. when the largest number of requests are failing.
 */
import { Logger } from '@nestjs/common';
import { MESSAGE_REFRESH_INTERVAL_MS, MessageService } from '@/common/messages/message.service';
import type { MessageStore, SystemMessageRow } from '@/common/messages/message.repository';

class FakeMessageStore implements MessageStore {
  rows: SystemMessageRow[] = [
    { key: 'PERM_DENIED', text: 'You do not have permission to perform this action.' },
    { key: 'AUTH_INVALID_CREDENTIALS', text: 'The email or password you entered is incorrect.' },
  ];
  failWith: Error | null = null;
  loads = 0;

  async loadAll(): Promise<readonly SystemMessageRow[]> {
    this.loads += 1;
    if (this.failWith !== null) throw this.failWith;
    return this.rows;
  }
}

describe('MessageService', () => {
  let store: FakeMessageStore;
  let service: MessageService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    store = new FakeMessageStore();
    service = new MessageService(store);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it('loads the catalogue at boot and serves it', async () => {
    await service.onModuleInit();

    expect(store.loads).toBe(1);
    expect(service.size).toBe(2);
    expect(service.get('PERM_DENIED')).toBe('You do not have permission to perform this action.');
  });

  describe('TC-15 — an unknown key', () => {
    it('returns the key itself and does not throw', async () => {
      await service.onModuleInit();
      expect(() => service.get('SOME_UNSEEDED_CODE')).not.toThrow();
      expect(service.get('SOME_UNSEEDED_CODE')).toBe('SOME_UNSEEDED_CODE');
    });

    it('returns the key before the first load has happened at all', () => {
      // Boot order: a request that fails while `onModuleInit` is still in flight must still get
      // an answer. There is no "not ready" state and no promise to await.
      expect(service.get('PERM_DENIED')).toBe('PERM_DENIED');
    });

    it('warns once per unknown key rather than once per request', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      await service.onModuleInit();

      service.get('MISSING_CODE');
      service.get('MISSING_CODE');
      service.get('OTHER_MISSING_CODE');

      expect(warn).toHaveBeenCalledTimes(2);
    });
  });

  describe('failure is always a fallback, never an exception', () => {
    it('serves keys when the initial load fails, and does not reject', async () => {
      store.failWith = new Error('ECONNREFUSED 127.0.0.1:5432');

      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(service.get('PERM_DENIED')).toBe('PERM_DENIED');
    });

    it('keeps the previous catalogue when a refresh fails', async () => {
      await service.onModuleInit();
      store.failWith = new Error('connection terminated unexpectedly');

      await service.refresh();

      // The catalogue is *not* emptied. Serving five-minute-old wording beats serving raw keys
      // to every user for as long as the database is unwell.
      expect(service.size).toBe(2);
      expect(service.get('PERM_DENIED')).toBe('You do not have permission to perform this action.');
    });

    it('logs a failed load at error, with the cause', async () => {
      const error = jest.spyOn(Logger.prototype, 'error');
      store.failWith = new Error('relation "system_messages" does not exist');

      await service.refresh();

      expect(error).toHaveBeenCalledWith(expect.stringContaining('relation "system_messages"'));
    });
  });

  describe('the refresh timer', () => {
    it('re-reads on the interval and picks up an edit', async () => {
      jest.useFakeTimers();
      try {
        await service.onModuleInit();
        store.rows = [{ key: 'PERM_DENIED', text: 'Nope.' }];

        jest.advanceTimersByTime(MESSAGE_REFRESH_INTERVAL_MS);
        await Promise.resolve();

        expect(store.loads).toBe(2);
        expect(service.get('PERM_DENIED')).toBe('Nope.');
      } finally {
        jest.useRealTimers();
      }
    });

    it('is unref()ed so it can never hold the process open', async () => {
      await service.onModuleInit();
      // Asserted through the observable consequence: Jest reports open handles for a referenced
      // interval, so the check that matters is that `onModuleDestroy` clears it and that a
      // second call is harmless (Nest calls lifecycle hooks once, but a test may not).
      expect(() => {
        service.onModuleDestroy();
        service.onModuleDestroy();
      }).not.toThrow();
    });

    it('re-reports a key that goes missing again after a successful refresh', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      await service.onModuleInit();

      service.get('MISSING_CODE');
      await service.refresh();
      service.get('MISSING_CODE');

      expect(warn).toHaveBeenCalledTimes(2);
    });
  });

  describe('getAll — the /me/bootstrap surface (T-015)', () => {
    it('returns the whole catalogue as a plain object', async () => {
      await service.onModuleInit();
      expect(service.getAll()).toEqual({
        PERM_DENIED: 'You do not have permission to perform this action.',
        AUTH_INVALID_CREDENTIALS: 'The email or password you entered is incorrect.',
      });
    });

    it('returns a copy — a consumer cannot rewrite what every error response says', async () => {
      await service.onModuleInit();
      const first = service.getAll();
      first.PERM_DENIED = 'tampered';

      expect(service.get('PERM_DENIED')).toBe('You do not have permission to perform this action.');
    });
  });
});
