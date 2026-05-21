import { describe, it, expect, vi, afterEach } from 'vitest';
import { ErrorCode } from '@plansync/shared';
import { isPrivateOrLoopbackHost } from '../../src/lib/webhook-url-validator';

describe('R-043: isPrivateOrLoopbackHost', () => {
  it('flags literal IPv4 ranges that are private / loopback / link-local', () => {
    expect(isPrivateOrLoopbackHost('127.0.0.1')).toBe(true);
    expect(isPrivateOrLoopbackHost('10.1.2.3')).toBe(true);
    expect(isPrivateOrLoopbackHost('172.16.0.5')).toBe(true);
    expect(isPrivateOrLoopbackHost('172.31.255.255')).toBe(true);
    expect(isPrivateOrLoopbackHost('192.168.1.1')).toBe(true);
    // EC2 instance metadata
    expect(isPrivateOrLoopbackHost('169.254.169.254')).toBe(true);
    // CGNAT
    expect(isPrivateOrLoopbackHost('100.64.0.1')).toBe(true);
    // "this network"
    expect(isPrivateOrLoopbackHost('0.0.0.0')).toBe(true);
  });

  it('does not flag public IPv4 addresses', () => {
    expect(isPrivateOrLoopbackHost('8.8.8.8')).toBe(false);
    expect(isPrivateOrLoopbackHost('172.15.0.1')).toBe(false);
    expect(isPrivateOrLoopbackHost('172.32.0.1')).toBe(false);
    expect(isPrivateOrLoopbackHost('151.101.1.1')).toBe(false);
  });

  it('flags loopback / unique-local / link-local IPv6 addresses', () => {
    expect(isPrivateOrLoopbackHost('::1')).toBe(true);
    expect(isPrivateOrLoopbackHost('::')).toBe(true);
    expect(isPrivateOrLoopbackHost('fc00::1')).toBe(true);
    expect(isPrivateOrLoopbackHost('fd12:3456:789a::1')).toBe(true);
    expect(isPrivateOrLoopbackHost('fe80::1')).toBe(true);
    expect(isPrivateOrLoopbackHost('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrLoopbackHost('::ffff:10.0.0.1')).toBe(true);
  });

  it('does not flag a public IPv6 address', () => {
    expect(isPrivateOrLoopbackHost('2606:4700:4700::1111')).toBe(false);
  });

  it('flags "localhost" and *.localhost / *.local hostnames', () => {
    expect(isPrivateOrLoopbackHost('localhost')).toBe(true);
    expect(isPrivateOrLoopbackHost('foo.localhost')).toBe(true);
    expect(isPrivateOrLoopbackHost('printer.local')).toBe(true);
    expect(isPrivateOrLoopbackHost('ip6-localhost')).toBe(true);
  });

  it('does not flag a regular public hostname', () => {
    expect(isPrivateOrLoopbackHost('hooks.example.com')).toBe(false);
    expect(isPrivateOrLoopbackHost('api.github.com')).toBe(false);
  });
});

describe('R-043: validateWebhookUrl', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  async function loadValidator(envOverrides: Record<string, string | undefined>) {
    vi.resetModules();
    for (const [k, v] of Object.entries(envOverrides)) {
      vi.stubEnv(k, v ?? '');
    }
    const mod = await import('../../src/lib/webhook-url-validator');
    return mod;
  }

  it('rejects an unparseable URL', async () => {
    const { validateWebhookUrl } = await loadValidator({});
    expect(() => validateWebhookUrl('not-a-url')).toThrow(/Invalid webhook URL/);
  });

  it('rejects non-http(s) schemes regardless of NODE_ENV', async () => {
    const { validateWebhookUrl } = await loadValidator({ NODE_ENV: 'development' });
    expect(() => validateWebhookUrl('file:///etc/passwd')).toThrow(/must use http or https/);
    expect(() => validateWebhookUrl('ftp://example.com/x')).toThrow(/must use http or https/);
  });

  it('allows http://localhost in non-production (back-compat with existing tests)', async () => {
    const { validateWebhookUrl } = await loadValidator({ NODE_ENV: 'test' });
    expect(() => validateWebhookUrl('http://localhost:1234/hook')).not.toThrow();
    expect(() => validateWebhookUrl('http://127.0.0.1:1234/hook')).not.toThrow();
  });

  it('requires https in production', async () => {
    const { validateWebhookUrl } = await loadValidator({
      NODE_ENV: 'production',
      PLANSYNC_SECRET: 'x'.repeat(64),
    });
    expect(() => validateWebhookUrl('http://hooks.example.com/x')).toThrow(/must use https/);
    expect(() => validateWebhookUrl('https://hooks.example.com/x')).not.toThrow();
  });

  it('blocks loopback host in production', async () => {
    const { validateWebhookUrl } = await loadValidator({
      NODE_ENV: 'production',
      PLANSYNC_SECRET: 'x'.repeat(64),
    });
    expect(() => validateWebhookUrl('https://127.0.0.1/h')).toThrow(/private \/ loopback/);
    expect(() => validateWebhookUrl('https://localhost/h')).toThrow(/private \/ loopback/);
  });

  it('blocks EC2 metadata IP in production', async () => {
    const { validateWebhookUrl } = await loadValidator({
      NODE_ENV: 'production',
      PLANSYNC_SECRET: 'x'.repeat(64),
    });
    let caught: unknown;
    try {
      validateWebhookUrl('https://169.254.169.254/latest/meta-data/');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const err = caught as { code?: string; message?: string };
    expect(err.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(err.message).toMatch(/169\.254\.169\.254/);
  });

  it('blocks private IPv4 ranges in production', async () => {
    const { validateWebhookUrl } = await loadValidator({
      NODE_ENV: 'production',
      PLANSYNC_SECRET: 'x'.repeat(64),
    });
    expect(() => validateWebhookUrl('https://10.0.0.5/h')).toThrow(/private \/ loopback/);
    expect(() => validateWebhookUrl('https://172.20.0.1/h')).toThrow(/private \/ loopback/);
    expect(() => validateWebhookUrl('https://192.168.1.1/h')).toThrow(/private \/ loopback/);
  });

  it('blocks IPv6 loopback / link-local in production', async () => {
    const { validateWebhookUrl } = await loadValidator({
      NODE_ENV: 'production',
      PLANSYNC_SECRET: 'x'.repeat(64),
    });
    expect(() => validateWebhookUrl('https://[::1]/h')).toThrow(/private \/ loopback/);
    expect(() => validateWebhookUrl('https://[fe80::1]/h')).toThrow(/private \/ loopback/);
  });

  it('allows public hosts in production', async () => {
    const { validateWebhookUrl } = await loadValidator({
      NODE_ENV: 'production',
      PLANSYNC_SECRET: 'x'.repeat(64),
    });
    expect(() => validateWebhookUrl('https://hooks.example.com/path')).not.toThrow();
    expect(() => validateWebhookUrl('https://api.github.com/webhooks/x')).not.toThrow();
  });

  it('honours PLANSYNC_WEBHOOK_ALLOWLIST in production', async () => {
    const { validateWebhookUrl } = await loadValidator({
      NODE_ENV: 'production',
      PLANSYNC_SECRET: 'x'.repeat(64),
      PLANSYNC_WEBHOOK_ALLOWLIST: 'internal.svc.cluster.local,127.0.0.1',
    });
    // Allowlisted host + http permitted
    expect(() => validateWebhookUrl('http://internal.svc.cluster.local/hook')).not.toThrow();
    expect(() => validateWebhookUrl('http://127.0.0.1:9000/hook')).not.toThrow();
    // Non-allowlisted private host still blocked
    expect(() => validateWebhookUrl('https://10.0.0.5/h')).toThrow(/private \/ loopback/);
  });
});

