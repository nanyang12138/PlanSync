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
