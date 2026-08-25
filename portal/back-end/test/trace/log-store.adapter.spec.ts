/**
 * T-045 — the three `LogStoreAdapter` implementations (implementation note 2/3). The property
 * every one of them must hold: never throw, and answer `null` — not an empty array — when the
 * source genuinely could not be reached.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileLogStoreAdapter,
  HttpLogStoreAdapter,
  NullLogStoreAdapter,
} from '@/modules/trace/adapters/log-store.adapter';

describe('NullLogStoreAdapter', () => {
  it('always answers null (implementation note 3 default)', async () => {
    const adapter = new NullLogStoreAdapter();
    await expect(adapter.fetchLines('01J8F3K9QP2M7N', 100)).resolves.toBeNull();
  });
});

describe('FileLogStoreAdapter', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 't045-log-'));
    filePath = join(dir, 'app.log');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeLines(lines: readonly unknown[]): void {
    writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  }

  it('returns null when the file does not exist (TC-5-style degradation)', async () => {
    const adapter = new FileLogStoreAdapter(join(dir, 'missing.log'));
    await expect(adapter.fetchLines('01J8F3K9QP2M7N', 10)).resolves.toBeNull();
  });

  it('returns only the lines matching the correlation id, in file order', async () => {
    writeLines([
      { correlationId: 'aaaaaaaaaaaaaaaa', msg: 'request completed' },
      { correlationId: '01J8F3K9QP2M7N', msg: 'jwt.verify', order: 1 },
      { correlationId: '01J8F3K9QP2M7N', msg: 'request completed', order: 2 },
      { correlationId: 'bbbbbbbbbbbbbbbb', msg: 'request completed' },
    ]);

    const adapter = new FileLogStoreAdapter(filePath);
    const lines = await adapter.fetchLines('01J8F3K9QP2M7N', 10);

    expect(lines).not.toBeNull();
    expect(lines?.map((line) => line.order)).toEqual([1, 2]);
  });

  it('returns [] — not null — when the file exists but has no matching lines (TC-6 half)', async () => {
    writeLines([{ correlationId: 'other-id-here', msg: 'request completed' }]);

    const adapter = new FileLogStoreAdapter(filePath);
    await expect(adapter.fetchLines('01J8F3K9QP2M7N', 10)).resolves.toEqual([]);
  });

  it('skips a malformed line rather than failing the whole read', async () => {
    writeFileSync(
      filePath,
      [
        'not valid json at all',
        JSON.stringify({ correlationId: '01J8F3K9QP2M7N', msg: 'ok' }),
        '',
      ].join('\n'),
    );

    const adapter = new FileLogStoreAdapter(filePath);
    const lines = await adapter.fetchLines('01J8F3K9QP2M7N', 10);
    expect(lines).toHaveLength(1);
  });

  it('never returns more than `limit` lines', async () => {
    writeLines(
      Array.from({ length: 20 }, (_, i) => ({ correlationId: '01J8F3K9QP2M7N', order: i })),
    );

    const adapter = new FileLogStoreAdapter(filePath);
    const lines = await adapter.fetchLines('01J8F3K9QP2M7N', 5);
    expect(lines).toHaveLength(5);
  });

  it('a line without a string correlationId is ignored, not matched by accident', async () => {
    writeFileSync(filePath, `${JSON.stringify({ correlationId: 42, msg: 'weird' })}\n`);

    const adapter = new FileLogStoreAdapter(filePath);
    await expect(adapter.fetchLines('42', 10)).resolves.toEqual([]);
  });
});

describe('HttpLogStoreAdapter', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns the parsed array on a 200 response', async () => {
    const lines = [{ correlationId: '01J8F3K9QP2M7N', msg: 'request completed' }];
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => lines,
    }) as unknown as typeof fetch;

    const adapter = new HttpLogStoreAdapter('https://logs.example.invalid/query', null);
    await expect(adapter.fetchLines('01J8F3K9QP2M7N', 10)).resolves.toEqual(lines);
  });

  it('sends the correlation id and limit as query parameters', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => [] });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const adapter = new HttpLogStoreAdapter('https://logs.example.invalid/query', null);
    await adapter.fetchLines('01J8F3K9QP2M7N', 42);

    const calledUrl = fetchMock.mock.calls[0][0] as URL;
    expect(calledUrl.searchParams.get('correlationId')).toBe('01J8F3K9QP2M7N');
    expect(calledUrl.searchParams.get('limit')).toBe('42');
  });

  it('sends a bearer token when one is configured, and no Authorization header otherwise', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => [] });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await new HttpLogStoreAdapter('https://logs.example.invalid/query', 'tok-123').fetchLines(
      'id',
      1,
    );
    const [, withToken] = fetchMock.mock.calls[0] as [unknown, { headers: Record<string, string> }];
    expect(withToken.headers.Authorization).toBe('Bearer tok-123');

    fetchMock.mockClear();
    await new HttpLogStoreAdapter('https://logs.example.invalid/query', null).fetchLines('id', 1);
    const [, withoutToken] = fetchMock.mock.calls[0] as [
      unknown,
      { headers: Record<string, string> },
    ];
    expect(withoutToken.headers.Authorization).toBeUndefined();
  });

  it('returns null on a non-2xx response', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => [],
    }) as unknown as typeof fetch;

    const adapter = new HttpLogStoreAdapter('https://logs.example.invalid/query', null);
    await expect(adapter.fetchLines('id', 10)).resolves.toBeNull();
  });

  it('returns null when the backend answers with something other than a JSON array', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ not: 'an array' }),
    }) as unknown as typeof fetch;

    const adapter = new HttpLogStoreAdapter('https://logs.example.invalid/query', null);
    await expect(adapter.fetchLines('id', 10)).resolves.toBeNull();
  });

  it('returns null rather than throwing when the fetch itself rejects (network failure)', async () => {
    globalThis.fetch = jest
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const adapter = new HttpLogStoreAdapter('https://logs.example.invalid/query', null);
    await expect(adapter.fetchLines('id', 10)).resolves.toBeNull();
  });

  it('aborts and reports unavailable when the backend does not answer within the timeout', async () => {
    globalThis.fetch = jest.fn().mockImplementation(
      (_url: unknown, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ) as unknown as typeof fetch;

    const adapter = new HttpLogStoreAdapter('https://logs.example.invalid/query', null, 5);
    await expect(adapter.fetchLines('id', 10)).resolves.toBeNull();
  });

  it('never returns more than `limit` entries even if the backend ignores the hint', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ order: i }));
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => many }) as unknown as typeof fetch;

    const adapter = new HttpLogStoreAdapter('https://logs.example.invalid/query', null);
    const lines = await adapter.fetchLines('id', 3);
    expect(lines).toHaveLength(3);
  });
});
