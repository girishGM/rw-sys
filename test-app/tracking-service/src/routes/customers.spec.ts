import request from 'supertest';
import { createApp } from '../app';
import { CUSTOMERS } from '../data/customers';
import { buildFixtureStores } from '../test-support/fixtures';
import { SseHub, type AppState } from './index';

function buildState(): AppState {
  return { customers: CUSTOMERS, ...buildFixtureStores(), sse: new SseHub() };
}

describe('GET /api/customers', () => {
  it('TC-1: returns the 3-customer demo roster', async () => {
    const response = await request(createApp(buildState())).get('/api/customers');

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(3);
    expect(response.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'priya-shah', displayName: 'Priya Shah' }),
      ]),
    );
  });
});
