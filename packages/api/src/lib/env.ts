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

  // R-088: Event-bus backend selection.
  //   memory   — in-process fan-out only (single API instance).
  //   postgres — Postgres LISTEN/NOTIFY (required for multi-instance prod).
  // Default: postgres in production, memory elsewhere.
  PLANSYNC_EVENT_BUS: z.enum(['memory', 'postgres']).optional(),

  // R-171: Exec-state FSM enforcement mode for the MCP server.
  //   off      — manager not attached. Tool calls proceed as pre-R-171.
  //              Default; safe for the initial rollout.
  //   shadow   — illegal transitions logged as WARN; tool call proceeds.
  //              Use this for ~1 week to surface false positives before
  //              flipping to enforce.
  //   enforce  — illegal transitions short-circuit with OUT_OF_SEQUENCE
  //              (see docs/PROTOCOL.md). Handler is never invoked.
  // The flag is read by the MCP server at startup; this entry exists in
  // the API env schema only so env.ts stays the single inventory of
  // PlanSync-* env vars.
  PLANSYNC_EXEC_STATE_ENFORCE: z.enum(['off', 'shadow', 'enforce']).optional(),

  // R-136: master-delegation (PLANSYNC_SECRET) abuse controls.
  //
  // Until R-136, anyone with PLANSYNC_SECRET could impersonate any user
  // for any action with no audit trail. The variables below add:
  //   - explicit allow / deny lists for impersonation targets
  //   - a per-episode TTL after which the delegation expires
  //   - a hard production fail-closed: if ALLOWED_TARGETS is unset in
  //     production, master delegation is REJECTED entirely (handled in
  //     master-audit.ts isMasterTargetAllowed)
  //
  // PLANSYNC_MASTER_ALLOWED_TARGETS — CSV of allowed target user names.
  //   Production: REQUIRED for master delegation to work at all. Unset
  //     means master path is disabled (fail-closed).
  //   Dev / test: optional. When unset, all targets pass the allow check.
  // PLANSYNC_MASTER_DENY_TARGETS — CSV of denied target user names.
  //   Evaluated AFTER the allow check; deny wins over allow.
  // PLANSYNC_MASTER_DELEGATION_TTL_MIN — integer minutes (default 60,
  //   clamped to [1, 1440]). Each delegation episode (one row in the
  //   master_delegations audit table) expires at insert-time + this many
  //   minutes; subsequent master calls after expiry are rejected with
  //   `MASTER_DELEGATION_EXPIRED` and must trigger a fresh episode.
  // PLANSYNC_MASTER_LEGACY — escape hatch for dev. Set to "true" to
  //   bypass ALL R-136 checks (no audit, no allow / deny, no TTL).
  //   REFUSED in production via the superRefine guard below.
  PLANSYNC_MASTER_ALLOWED_TARGETS: z.string().optional(),
  PLANSYNC_MASTER_DENY_TARGETS: z.string().optional(),
  PLANSYNC_MASTER_DELEGATION_TTL_MIN: z.coerce.number().int().min(1).max(1440).default(60),
  PLANSYNC_MASTER_LEGACY: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
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

  // R-136: PLANSYNC_MASTER_LEGACY is a dev-only bypass that skips audit,
  // allow / deny lists, and TTL. Refuse it in production so a forgotten
  // dev override can never reach a live deployment.
  if (data.PLANSYNC_MASTER_LEGACY === true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PLANSYNC_MASTER_LEGACY'],
      message:
        'PLANSYNC_MASTER_LEGACY=true is refused in production — it disables ' +
        'all R-136 master-delegation abuse controls (audit, allow / deny, TTL). ' +
        'Unset it for production deploys.',
    });
  }
});

function validateEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment variables:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    if (process.env.NODE_ENV === 'production') {
      console.error('Aborting startup due to invalid production environment configuration.');
      process.exit(1);
    }
    throw new Error('Environment validation failed');
  }
  return result.data;
}

export const env = validateEnv();
export type Env = z.infer<typeof envSchema>;
