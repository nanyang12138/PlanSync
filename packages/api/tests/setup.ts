// Set env vars at module level so Prisma sees them before instantiation
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  `postgresql://${process.env.USER || 'postgres'}@localhost:15432/plansync_dev`;
process.env.PLANSYNC_SECRET = process.env.PLANSYNC_SECRET || 'test-secret';
process.env.AUTH_DISABLED = 'true';
Reflect.set(process.env, 'NODE_ENV', 'test');
process.env.LOG_LEVEL = 'error';

// R-124: enable the deterministic AI mock provider by default so the AI test
// surface is exercised in CI without real API keys. Opt-in to real LLM calls
// by clearing this and setting PLANSYNC_AI_TESTS=1 plus a real key.
if (process.env.PLANSYNC_AI_TESTS !== '1' && process.env.PLANSYNC_AI_MOCK === undefined) {
  process.env.PLANSYNC_AI_MOCK = '1';
}
