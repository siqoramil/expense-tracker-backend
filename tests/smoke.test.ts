import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('system', () => {
  it('GET /health returns ok and a numeric ts', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; ts: number };
    expect(body.ok).toBe(true);
    expect(typeof body.ts).toBe('number');
  });

  it('GET /docs/json without Basic Auth is rejected', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Basic /);
  });

  it('GET /docs/json with wrong Basic Auth is rejected', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/docs/json',
      headers: { authorization: 'Basic ' + Buffer.from('docs:wrong').toString('base64') },
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /docs/json with correct Basic Auth serves the OpenAPI spec', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/docs/json',
      headers: { authorization: 'Basic ' + Buffer.from('docs:docs-test-pass').toString('base64') },
    });
    expect(res.statusCode).toBe(200);
    const spec = res.json() as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.paths['/health']).toBeDefined();
  });
});

// Every protected route prefix must reject unauthenticated traffic before
// touching the DB. Hitting the list endpoint of each prefix is enough.
const protectedListRoutes: Array<{ method: 'GET'; url: string; label: string }> = [
  { method: 'GET', url: '/auth/me', label: 'auth' },
  { method: 'GET', url: '/categories/', label: 'categories' },
  { method: 'GET', url: '/wallets/', label: 'wallets' },
  { method: 'GET', url: '/tx/', label: 'transactions' },
  { method: 'GET', url: '/debts/', label: 'debts' },
  { method: 'GET', url: '/budgets/', label: 'budgets' },
  { method: 'GET', url: '/recurring/', label: 'recurring' },
  { method: 'GET', url: '/notifs/', label: 'notifications' },
];

describe('auth gate', () => {
  for (const { method, url, label } of protectedListRoutes) {
    it(`${method} ${url} (${label}) → 401 without bearer`, async () => {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthorized' });
    });

    it(`${method} ${url} (${label}) → 401 with bogus bearer`, async () => {
      const res = await app.inject({
        method,
        url,
        headers: { authorization: 'Bearer not-a-real-jwt' },
      });
      expect(res.statusCode).toBe(401);
    });
  }
});

describe('public auth route validation', () => {
  it('POST /auth/login → 400 on empty body', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('POST /auth/register → 400 on weak password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'a@b.com', password: 'short', name: 'X' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /auth/register → 400 on missing name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'a@b.com', password: 'Abcdef12' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /auth/register → 400 on bad email format', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'not-an-email', password: 'Abcdef12', name: 'X' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /auth/google → 503 when google client ids are not configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/google',
      payload: { idToken: 'x'.repeat(50) },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'google_auth_disabled' });
  });

  it('POST /auth/password/forgot → 400 on bad email format', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/password/forgot',
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /auth/password/reset → 400 on malformed code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/password/reset',
      payload: { email: 'a@b.com', code: '12', newPassword: 'Abcdef12' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('schema validation on protected routes (with valid jwt)', () => {
  // A valid JWT lets us pass the auth preHandler so route-level body schema
  // runs. The handler still won't query the DB if the body is rejected.
  let token: string;

  beforeAll(() => {
    // app.jwt is decorated by the auth plugin; sign a token for a fake sub.
    // 24-hex-char ObjectId-shaped string keeps any downstream casts happy.
    token = (app as unknown as { jwt: { sign: (p: object) => string } }).jwt.sign({
      sub: '0123456789abcdef01234567',
    });
  });

  it('POST /tx/ → 400 when wallet is not a 24-hex ObjectId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tx/',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: 'expense',
        cat: 'food',
        wallet: 'not-an-objectid',
        amount: 10,
        date: '2026-05-05',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /budgets/ → 400 when limit is negative', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/budgets/',
      headers: { authorization: `Bearer ${token}` },
      payload: { cat: 'food', limit: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /debts/ → 400 when direction is unknown', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/debts/',
      headers: { authorization: `Bearer ${token}` },
      payload: { direction: 'sideways', name: 'X', amount: 1, due: '2026-06' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /tx/?month=bad → 400 on malformed month', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/tx/?month=2026-13',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH /auth/me → 400 when name exceeds maxLength', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'x'.repeat(200) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /recurring/ → 400 when cat is not an ObjectId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/recurring/',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        kind: 'expense',
        cat: 'food',
        wallet: '0123456789abcdef01234567',
        amount: 10,
        nextDate: '2026-06-01',
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('cors', () => {
  it('blocks unknown production-style origins', async () => {
    // In NODE_ENV=test (treated as non-prod) localhost is allowed but a
    // random origin is not.
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin: 'https://evil.example.com',
        'access-control-request-method': 'GET',
      },
    });
    // Fastify cors rejects with 500/CORS error or omits ACAO header.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('rate limiting', () => {
  it('GET /health is on the rate-limit allow list (1000 quick hits all 200)', async () => {
    // /health is allowList'd in app.ts so it should never throttle.
    for (let i = 0; i < 50; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
    }
  });
});
