import request from 'supertest';
import { createApp } from '../app';
import { CUSTOMERS } from '../data/customers';
import {
  buildFixtureStores,
  FIXTURE_ALL_CAMPAIGN_ID,
  FIXTURE_NOF_CAMPAIGN_ID,
} from '../test-support/fixtures';
import { SseHub, type AppState } from './index';

function buildState(): AppState {
  return { customers: CUSTOMERS, ...buildFixtureStores(), sse: new SseHub() };
}

describe('POST /api/activities', () => {
  it('TC-5: an activity that does not complete a tracker increments progress, no new reward', async () => {
    const app = createApp(buildState());

    const response = await request(app).post('/api/activities').send({
      customerId: 'priya-shah',
      activityType: 'Grocery Purchase',
      merchant: 'ACME',
      amount: 12.5,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.matched).toBe(true);
    expect(response.body.data.rewards).toEqual([]);
    expect(response.body.data.progress).toEqual([
      expect.objectContaining({
        campaignId: FIXTURE_ALL_CAMPAIGN_ID,
        trackerId: 2001,
        componentId: 3001,
        completedCount: 1,
        threshold: 2,
        trackerCompleted: false,
      }),
    ]);
  });

  it('TC-6/TC-7: completion_logic=all only fires once BOTH components are complete', async () => {
    const state = buildState();
    const app = createApp(state);

    await request(app)
      .post('/api/activities')
      .send({ customerId: 'priya-shah', activityType: 'Grocery Purchase' });
    const second = await request(app)
      .post('/api/activities')
      .send({ customerId: 'priya-shah', activityType: 'Weekend Transaction' });

    expect(second.body.data.progress[0].trackerCompleted).toBe(true);
    expect(second.body.data.rewards).toHaveLength(1);
    expect(second.body.data.rewards[0]).toEqual(
      expect.objectContaining({
        customerId: 'priya-shah',
        campaignId: FIXTURE_ALL_CAMPAIGN_ID,
        campaignCode: 'FIXTURE_ALL',
        type: 'promo_code',
        status: 'unused',
      }),
    );

    // and it really landed in the ledger, not just the response body
    const ledger = await request(app).get('/api/rewards?customerId=priya-shah');
    expect(ledger.body.data).toHaveLength(1);
    expect(ledger.body.data[0].id).toBe(second.body.data.rewards[0].id);
  });

  it('TC-8: completion_logic=n_of fires once the real completionThreshold count is complete', async () => {
    const state = buildState();
    const app = createApp(state);

    const first = await request(app)
      .post('/api/activities')
      .send({ customerId: 'priya-shah', activityType: 'Refer a Friend' });
    expect(first.body.data.rewards).toEqual([]);

    const second = await request(app)
      .post('/api/activities')
      .send({ customerId: 'priya-shah', activityType: 'Refer a Friend' });
    expect(second.body.data.progress[0]).toEqual(
      expect.objectContaining({
        campaignId: FIXTURE_NOF_CAMPAIGN_ID,
        completedCount: 2,
        threshold: 2,
      }),
    );
    expect(second.body.data.rewards).toHaveLength(1);
    expect(second.body.data.rewards[0].type).toBe('points');

    // a 3rd matching activity must not award a second reward for the same already-complete tracker
    const third = await request(app)
      .post('/api/activities')
      .send({ customerId: 'priya-shah', activityType: 'Refer a Friend' });
    expect(third.body.data.rewards).toEqual([]);

    const ledger = await request(app).get('/api/rewards?customerId=priya-shah');
    expect(ledger.body.data).toHaveLength(1);
  });

  it('TC-9-adjacent: emits progress-updated to the SseHub for a matched, non-completing activity', async () => {
    const state = buildState();
    const app = createApp(state);
    const emitted: Array<{ event: string; data: unknown }> = [];
    const originalEmit = state.sse.emit.bind(state.sse);
    state.sse.emit = (customerId, event, data) => {
      emitted.push({ event, data });
      originalEmit(customerId, event, data);
    };

    await request(app)
      .post('/api/activities')
      .send({ customerId: 'priya-shah', activityType: 'Grocery Purchase' });

    expect(emitted).toEqual([{ event: 'progress-updated', data: expect.any(Object) }]);
  });

  it('TC-10-adjacent: a different customer’s activity never emits on another customer’s behalf', async () => {
    const state = buildState();
    const app = createApp(state);
    const emittedFor: string[] = [];
    const originalEmit = state.sse.emit.bind(state.sse);
    state.sse.emit = (customerId, event, data) => {
      emittedFor.push(customerId);
      originalEmit(customerId, event, data);
    };

    await request(app)
      .post('/api/activities')
      .send({ customerId: 'marcus-tan', activityType: 'Grocery Purchase' });

    expect(emittedFor).toEqual(['marcus-tan']);
  });

  it('TC-11: unknown customerId -> 4xx, clear error, no crash', async () => {
    const app = createApp(buildState());

    const response = await request(app)
      .post('/api/activities')
      .send({ customerId: 'nobody', activityType: 'Grocery Purchase' });

    expect(response.status).toBe(404);
    expect(response.body.error).toMatch(/nobody/);
  });

  it('missing customerId -> 400', async () => {
    const app = createApp(buildState());
    const response = await request(app)
      .post('/api/activities')
      .send({ activityType: 'Grocery Purchase' });
    expect(response.status).toBe(400);
  });

  it('missing/blank activityType -> 400', async () => {
    const app = createApp(buildState());
    const response = await request(app).post('/api/activities').send({ customerId: 'priya-shah' });
    expect(response.status).toBe(400);
  });

  it('TC-12: an activityType matching no tracker component -> 2xx "no progress" response, not an error', async () => {
    const app = createApp(buildState());

    const response = await request(app)
      .post('/api/activities')
      .send({ customerId: 'priya-shah', activityType: 'Completely Unrelated Activity' });

    expect(response.status).toBe(200);
    expect(response.body.data.matched).toBe(false);
    expect(response.body.data.progress).toEqual([]);
    expect(response.body.data.rewards).toEqual([]);
  });
});

describe('GET /api/activities (T-013)', () => {
  it('TC-1: reproduces the reported defect on a fresh customer — [] history, no crash', async () => {
    const app = createApp(buildState());

    const response = await request(app).get('/api/activities?customerId=priya-shah');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });

  it('TC-2/TC-3 (regression): a POST is retrievable via GET immediately after, with a real description', async () => {
    const app = createApp(buildState());

    const post = await request(app).post('/api/activities').send({
      customerId: 'priya-shah',
      activityType: 'Grocery Purchase',
      merchant: 'ACME',
      amount: 12.5,
    });
    expect(post.status).toBe(200);

    const get = await request(app).get('/api/activities?customerId=priya-shah');

    expect(get.status).toBe(200);
    expect(get.body.data).toHaveLength(1);
    expect(get.body.data[0]).toEqual(
      expect.objectContaining({
        id: post.body.data.activityId,
        customerId: 'priya-shah',
        activityType: 'Grocery Purchase',
        merchant: 'ACME',
        amount: 12.5,
        description: 'Grocery Purchase — progress updated',
        matched: true,
        progress: post.body.data.progress,
        rewards: [],
      }),
    );
    expect(typeof get.body.data[0].timestamp).toBe('string');
  });

  it('TC-2-adjacent: a non-matching POST is still recorded (matched: false), not silently dropped', async () => {
    const app = createApp(buildState());

    await request(app)
      .post('/api/activities')
      .send({ customerId: 'priya-shah', activityType: 'Completely Unrelated Activity' });

    const get = await request(app).get('/api/activities?customerId=priya-shah');

    expect(get.body.data).toHaveLength(1);
    expect(get.body.data[0]).toEqual(
      expect.objectContaining({
        activityType: 'Completely Unrelated Activity',
        matched: false,
        description: 'Completely Unrelated Activity — no matching tracker',
      }),
    );
  });

  it('TC-3: multiple activities are returned most-recent-first', async () => {
    const app = createApp(buildState());

    await request(app)
      .post('/api/activities')
      .send({ customerId: 'priya-shah', activityType: 'Grocery Purchase' });
    await request(app)
      .post('/api/activities')
      .send({ customerId: 'priya-shah', activityType: 'Weekend Transaction' });

    const get = await request(app).get('/api/activities?customerId=priya-shah');

    expect(get.body.data).toHaveLength(2);
    expect(get.body.data[0].activityType).toBe('Weekend Transaction');
    expect(get.body.data[1].activityType).toBe('Grocery Purchase');
  });

  it('a completed tracker’s history entry carries the minted reward', async () => {
    const app = createApp(buildState());

    await request(app)
      .post('/api/activities')
      .send({ customerId: 'priya-shah', activityType: 'Grocery Purchase' });
    await request(app)
      .post('/api/activities')
      .send({ customerId: 'priya-shah', activityType: 'Weekend Transaction' });

    const get = await request(app).get('/api/activities?customerId=priya-shah');

    expect(get.body.data[0].rewards).toHaveLength(1);
    expect(get.body.data[0].description).toMatch(/reward earned/);
  });

  it('TC-4-adjacent: does not leak one customer’s history to another', async () => {
    const app = createApp(buildState());

    await request(app)
      .post('/api/activities')
      .send({ customerId: 'priya-shah', activityType: 'Grocery Purchase' });

    const get = await request(app).get('/api/activities?customerId=marcus-tan');

    expect(get.body.data).toEqual([]);
  });

  it('unknown customerId -> 4xx, clear error, no crash', async () => {
    const app = createApp(buildState());

    const response = await request(app).get('/api/activities?customerId=nobody');

    expect(response.status).toBe(404);
    expect(response.body.error).toMatch(/nobody/);
  });

  it('missing customerId -> 400', async () => {
    const app = createApp(buildState());

    const response = await request(app).get('/api/activities');

    expect(response.status).toBe(400);
  });
});
