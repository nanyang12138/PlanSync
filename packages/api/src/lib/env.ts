import { z } from 'zod';

const baseEnvSchema = z.object({
  DATABASE_URL: z.string().startsWith('postgresql://'),
  PLANSYNC_SECRET: z.string().min(1).optional(),
  AUTH_DISABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  // R-013: First-login open registration is OFF by default. Owners must
  // pre-create accounts via `bin/ps-admin create-user <name>`. Set this to
  // 'true' only on isolated dev hosts where you want anyone to claim a
  // username on first POST /api/auth/login.
  PLANSYNC_OPEN_REGISTRATION: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  PORT: z.coerce.number().default(3001),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // R-035: validate runtime-used env vars so misconfiguration surfaces at boot
  // instead of silently no-oping deep inside the AI / email subsystems.

  // AI features (Anthropic / AMD LLM). All optional — without one of the keys
  // AI features silently no-op (semantic diff, completion verification, etc.).
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_API_BASE: z.string().url().optional(),
  LLM_MODEL_NAME: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  ANTHROPIC_DEFAULT_SONNET_MODEL: z.string().min(1).optional(),
  ANTHROPIC_CUSTOM_HEADERS: z.string().optional(),

  // Email notifications (sendmail-based).
  EMAIL_FROM: z.string().min(1).optional(),
  EMAIL_DOMAIN: z.string().min(1).optional(),
  EMAIL_SENDMAIL: z.string().min(1).optional(),

  // R-043: SSRF allowlist for webhook target URLs. Comma-separated hostname
  // list. Hosts on the allowlist bypass the production-only private-IP and
  // https requirement enforced by `validateWebhookUrl`. Leave empty in
  // production unless you need to point a webhook at an internal host.
  PLANSYNC_WEBHOOK_ALLOWLIST: z.string().optional(),

  // R-139: opt-in durable webhook queue (DB-backed retry via webhook_jobs).
  // Must be exactly 'true' — anything else is treated as false. Validated here
  // so typos ('True', '1', 'treu') surface at boot instead of silently falling
  // back to the in-memory retry path (#799).
  PLANSYNC_WEBHOOK_QUEUE: z.enum(['true', 'false']).optional(),

  // R-088: Event-bus backend selection.
  //   memory   — in-process fan-out only (single API instance).
  //   postgres — Postgres LISTEN/NOTIFY (required for multi-instance prod).
  // Default: postgres in production, memory elsewhere.
  PLANSYNC_EVENT_BUS: z.enum(['memory', 'postgres']).optional(),

  // R-136: master-delegation knobs. Validated here so a typo (e.g.
  // `PLANSYNC_MASTER_DELEGATION_TTL_MIN=abc` → NaN → 0ms TTL → every
  // delegation immediately expired) fails at boot instead of silently
  // poisoning auth (closes #788). PLANSYNC_MASTER_LEGACY is the
  // explicit-bypass escape hatch for dev only — refused in production
  // by the superRefine block below (closes #791 #798).
  PLANSYNC_MASTER_LEGACY: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  PLANSYNC_MASTER_DELEGATION_TTL_MIN: z.coerce.number().positive().default(60),
  PLANSYNC_MASTER_ALLOWED_TARGETS: z.string().optional(),
  PLANSYNC_MASTER_DENY_TARGETS: z.string().optional(),
});

export const envSchema = baseEnvSchema.superRefine((data, ctx) => {
  if (data.NODE_ENV !== 'production') return;

  if (!data.PLANSYNC_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PLANSYNC_SECRET'],
      message:
        'PLANSYNC_SECRET is required in production. ' +
        'Generate a strong value with: openssl rand -hex 32',
    });
    return;
  }

  if (data.PLANSYNC_SECRET === 'dev-secret') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PLANSYNC_SECRET'],
      message:
        'PLANSYNC_SECRET must not be the development default "dev-secret" in production. ' +
        'Generate a strong value with: openssl rand -hex 32',
    });
  }

  if (data.PLANSYNC_SECRET.length < 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PLANSYNC_SECRET'],
      message:
        'PLANSYNC_SECRET must be at least 32 characters in production. ' +
        'Generate a strong value with: openssl rand -hex 32',
    });
  }

  // R-136: refuse the master-delegation bypass in production. The legacy
  // flag exists for one-off dev debugging; allowing it in production would
  // skip the audit trail / target allowlist / route allowlist / TTL all
  // at once. The fast path through env validation is the only place where
  // we can fail-closed before auth.ts even reads the var.
  // Closes #791 / #798 — these were filed because a previous refactor
  // dropped this guard from env.ts.
  if (data.PLANSYNC_MASTER_LEGACY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PLANSYNC_MASTER_LEGACY'],
      message:
        'PLANSYNC_MASTER_LEGACY=true is forbidden in production: it bypasses ' +
        'master-delegation audit, allowlist, deny-list, and TTL all at once. ' +
        'Use it only on dev hosts. Unset the variable to start in production.',
    });
  }

  // Refuse the no-auth mode in production. AUTH_DISABLED makes the server
  // trust the caller-supplied `X-User-Name` header as identity (auth.ts) —
  // no password, no API key — so anyone can impersonate any user, and the
  // entire owner-only / assignee-match authorization chain (R-009 / R-013)
  // collapses. It exists only for the local no-auth demo mode. Mirror the
  // PLANSYNC_MASTER_LEGACY guard above: fail-closed at boot so an operator
  // can never accidentally ship a header-spoofable production deployment.
  if (data.AUTH_DISABLED) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AUTH_DISABLED'],
      message:
        'AUTH_DISABLED=true is forbidden in production: identity would be taken ' +
        'from the unauthenticated X-User-Name header, letting anyone impersonate ' +
        'any user. Use it only on local demo/dev hosts. Unset the variable to ' +
        'start in production.',
    });
  }
});

function validateEnv() {
  // R-112: during `next build`, Next.js sets NEXT_PHASE=phase-production-build
  // and imports every module to discover page exports. Runtime env vars
  // (DATABASE_URL, PLANSYNC_SECRET, …) are not necessarily configured on the
  // build host, so strict validation here would crash the build for any
  // module that ends up in the page-data graph (e.g. logger.ts after R-112
  // started importing `env`). We inject a placeholder DATABASE_URL just for
  // the build-time analysis pass; the real runtime validation still fires at
  // server boot because the module is re-imported with the real env present.
  const isBuildAnalysis = process.env.NEXT_PHASE === 'phase-production-build';
  // During build-time analysis: also coerce NODE_ENV away from 'production'
  // so the superRefine guards (which demand PLANSYNC_SECRET >=32 chars,
  // refuse PLANSYNC_MASTER_LEGACY=true, etc.) don't fire against a
  // placeholder config. The real runtime re-validates with the production-
  // shaped env at server boot.
  const source: Record<string, string | undefined> = isBuildAnalysis
    ? {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://build-placeholder/plansync',
        NODE_ENV: 'development',
      }
    : process.env;
  const result = envSchema.safeParse(source);
  if (!result.success) {
    console.error('Invalid environment variables:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    if (process.env.NODE_ENV === 'production' && !isBuildAnalysis) {
      console.error('Aborting startup due to invalid production environment configuration.');
      process.exit(1);
    }
    throw new Error('Environment validation failed');
  }
  return result.data;
}

export const env = validateEnv();
export type Env = z.infer<typeof envSchema>;
