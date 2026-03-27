import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().startsWith('postgresql://'),
  PLANSYNC_SECRET: z.string().min(1).default('dev-secret'),
  AUTH_DISABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

function validateEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment variables:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    throw new Error('Environment validation failed');
  }
  return result.data;
}

export const env = validateEnv();
export type Env = z.infer<typeof envSchema>;
