// Set env vars at module level so Prisma sees them before instantiation
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  `postgresql://${process.env.USER || 'postgres'}@localhost:15432/plansync_dev`;
process.env.PLANSYNC_SECRET = process.env.PLANSYNC_SECRET || 'test-secret';
process.env.AUTH_DISABLED = 'true';
Reflect.set(process.env, 'NODE_ENV', 'test');
process.env.LOG_LEVEL = 'error';
