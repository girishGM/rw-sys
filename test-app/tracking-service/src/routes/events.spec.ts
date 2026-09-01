/**
 * T-004 — SSE can't be exercised meaningfully through supertest (it never resolves a request for
 * a stream that stays open), so these tests run a real, ephemeral `http` server and read raw
 * response chunks, exactly like this task's own curl-based verification steps do.
 */
import type { AddressInfo } from 'node:net';
import { createApp } from '../app';
import { CUSTOMERS } from '../data/customers';
import { buildFixtureStores } from '../test-support/fixtures';
import { SseHub, type AppState } from './index';

function buildState(): AppState {
  return { customers: CUSTOMERS, ...buildFixtureStores(), sse: new SseHub() };
}

function startServer(state: AppState): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createApp(state).listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://localhost:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function postActivity(baseUrl: string, body: Record<string, unknown>): Promise<void> {
  return fetch(`${baseUrl}/api/activities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(() => undefined);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('GET /api/events (SSE)', () => {
  it('TC-9: pushes a reward-earned event, with the right payload, when an activity completes a tracker', async () => {
    const state = buildState();
    const { baseUrl, close } = await startServer(state);
    let raw = '';

    try {
      const controller = new AbortController();
      const streamOpen = fetch(`${baseUrl}/api/events?customerId=priya-shah`, {
        signal: controller.signal,
      }).then(async (res) => {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        // eslint-disable-next-line no-constant-condition -- reads until aborted below
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          raw += decoder.decode(value);
        }
      });

      await wait(100); // let the SSE connection actually register (': connected\n\n' has flushed)

      await postActivity(baseUrl, { customerId: 'priya-shah', activityType: 'Grocery Purchase' });
      await postActivity(baseUrl, {
        customerId: 'priya-shah',
        activityType: 'Weekend Transaction',
      });

      await wait(150);
      controller.abort();
      await streamOpen.catch(() => undefined);

      expect(raw).toContain('event: progress-updated');
      expect(raw).toContain('event: reward-earned');

      const rewardEventLine = raw
        .split('\n\n')
        .find((chunk) => chunk.includes('event: reward-earned'));
      expect(rewardEventLine).toBeDefined();
      const dataLine = rewardEventLine!.split('\n').find((line) => line.startsWith('data: '));
      const payload = JSON.parse(dataLine!.slice('data: '.length));
      expect(payload).toEqual(
        expect.objectContaining({
          customerId: 'priya-shah',
          campaignCode: 'FIXTURE_ALL',
          status: 'unused',
        }),
      );
    } finally {
      await close();
    }
  });

  it('TC-10: an activity for a different customer never reaches this customer’s connection', async () => {
    const state = buildState();
    const { baseUrl, close } = await startServer(state);
    let raw = '';

    try {
      const controller = new AbortController();
      const streamOpen = fetch(`${baseUrl}/api/events?customerId=priya-shah`, {
        signal: controller.signal,
      }).then(async (res) => {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        // eslint-disable-next-line no-constant-condition -- reads until aborted below
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          raw += decoder.decode(value);
        }
      });

      await wait(100);
      await postActivity(baseUrl, { customerId: 'marcus-tan', activityType: 'Grocery Purchase' });
      await wait(150);

      controller.abort();
      await streamOpen.catch(() => undefined);

      expect(raw).not.toContain('event: progress-updated');
      expect(raw).not.toContain('event: reward-earned');
    } finally {
      await close();
    }
  });

  it('stays open and does not close immediately for a known customer (verification step 2)', async () => {
    const state = buildState();
    const { baseUrl, close } = await startServer(state);

    try {
      const controller = new AbortController();
      const res = await fetch(`${baseUrl}/api/events?customerId=priya-shah`, {
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      controller.abort();
    } finally {
      await close();
    }
  });

  it('4xx for an unknown customerId, without ever opening the stream', async () => {
    const state = buildState();
    const { baseUrl, close } = await startServer(state);

    try {
      const res = await fetch(`${baseUrl}/api/events?customerId=nobody`);
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });
});
