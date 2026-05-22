import { AppError, ErrorCode } from '@plansync/shared';

/**
 * R-043: Validate a webhook target URL to mitigate SSRF.
 *
 * Behaviour:
 * - Always: URL must parse and use http(s).
 * - In production: must be https.
 * - In production: host must not resolve to a literal private / loopback /
 *   link-local address (IPv4 or IPv6), and the hostname must not be the
 *   literal "localhost".
 * - The PLANSYNC_WEBHOOK_ALLOWLIST env var (comma-separated hostnames) can
 *   exempt specific hosts from the private-IP / scheme block.
 *
 * Note: this is a hostname / literal-IP check only. It does NOT perform DNS
 * resolution; defence against DNS-rebind style SSRF is out of scope for this
 * task and tracked separately.
 */
export function validateWebhookUrl(rawUrl: string): URL {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'url is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `Invalid webhook URL: ${rawUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `Webhook URL must use http or https, got: ${parsed.protocol}`,
    );
  }

  // Read env vars lazily: importing './env' at module top-level forces
  // env validation during Next.js production build's "Collecting page data"
  // phase, which fails because CI build job does not set DATABASE_URL.
  const allowlist = parseAllowlist(process.env.PLANSYNC_WEBHOOK_ALLOWLIST);
  const hostname = parsed.hostname.toLowerCase();
  const allowlisted = allowlist.includes(hostname);

  if (process.env.NODE_ENV === 'production' && !allowlisted) {
    if (parsed.protocol !== 'https:') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Webhook URL must use https in production');
    }

    if (isPrivateOrLoopbackHost(hostname)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Webhook URL host "${hostname}" is in a private / loopback / link-local range and is not allowed. Add it to PLANSYNC_WEBHOOK_ALLOWLIST to override.`,
      );
    }
  }

  return parsed;
}

function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Returns true if the given hostname is a literal IP in a private, loopback
 * or link-local range, or the literal "localhost" string. Returns false for
 * any DNS hostname (we do not resolve here).
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  if (!hostname) return true;
  const host = hostname.toLowerCase();

  if (host === 'localhost' || host === 'ip6-localhost' || host === 'ip6-loopback') {
    return true;
  }

  if (host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }

  const ipv4 = parseIPv4(host);
  if (ipv4) {
    return isPrivateIPv4(ipv4);
  }

  if (host.startsWith('[') && host.endsWith(']')) {
    return isPrivateIPv6(host.slice(1, -1));
  }
  if (host.includes(':')) {
    return isPrivateIPv6(host);
  }

  return false;
}

function parseIPv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [
    number,
    number,
    number,
    number,
  ];
  if (parts.some((p) => p < 0 || p > 255)) return null;
  return parts;
}

function isPrivateIPv4(parts: [number, number, number, number]): boolean {
  const [a, b] = parts;
  // 0.0.0.0/8 — "this network"
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (incl. cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 — CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  // fc00::/7 — unique local addresses
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  // fe80::/10 — link-local
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return true;
  // ::ffff:a.b.c.d — IPv4-mapped IPv6
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped) {
    const v4 = parseIPv4(mapped[1]);
    if (v4) return isPrivateIPv4(v4);
  }
  return false;
}
