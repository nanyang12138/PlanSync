// R+P module: Health check and OpenAPI
import { describe, it, expect } from 'vitest';
import { GET as healthGET } from '@/app/api/health/route';
import { GET as openapiGET } from '@/app/api/openapi.json/route';
import { makeReq } from '../helpers/request';

describe('R: Health Check', () => {
  it('R1: GET /api/health → 200, status=ok, database=connected', async () => {
    const res = await healthGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.database).toBe('connected');
    expect(typeof body.sseClients).toBe('number');
  });

  it('R3: sseClients field is a number', async () => {
    const res = await healthGET();
    const body = await res.json();
    expect(typeof body.sseClients).toBe('number');
    expect(body.sseClients).toBeGreaterThanOrEqual(0);
  });
});

describe('P: OpenAPI', () => {
  it('P1: GET /api/openapi.json → 200, valid JSON', async () => {
    const res = await openapiGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeTruthy();
    expect(typeof body).toBe('object');
  });
});
