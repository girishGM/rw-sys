import request from 'supertest';
import { createApp } from './app';
import { SseHub, type AppState } from './routes';
import { CUSTOMERS } from './data/customers';
import { buildFixtureStores } from './test-support/fixtures';

function buildTestState(): AppState {
  return { customers: CUSTOMERS, ...buildFixtureStores(), sse: new SseHub() };
}

describe('GET /health', () => {
  it('returns 200 with { status: "ok" }, independent of any mounted /api route', async () => {
    const app = createApp(buildTestState());

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});

describe('CORS', () => {
  it('allows the frontend dev origin (test-app/frontend/vite.config.ts)', async () => {
    const app = createApp(buildTestState());

    const response = await request(app).get('/health').set('Origin', 'http://localhost:5174');

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5174');
  });

  it('does not reflect an arbitrary origin', async () => {
    const app = createApp(buildTestState());

    const response = await request(app).get('/health').set('Origin', 'http://evil.example');

    expect(response.headers['access-control-allow-origin']).not.toBe('http://evil.example');
  });
});
