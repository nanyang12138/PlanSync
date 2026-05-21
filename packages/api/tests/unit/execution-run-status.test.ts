import { describe, it, expect } from 'vitest';
import { executionRunStatusSchema } from '@plansync/shared';

describe('executionRunStatusSchema — run lifecycle vocabulary', () => {
  it('accepts the legacy set of statuses', () => {
    for (const status of ['running', 'completed', 'failed', 'cancelled', 'stale']) {
      expect(() => executionRunStatusSchema.parse(status)).not.toThrow();
    }
  });

  it('accepts "superseded" (R-008)', () => {
    expect(() => executionRunStatusSchema.parse('superseded')).not.toThrow();
    expect(executionRunStatusSchema.parse('superseded')).toBe('superseded');
  });

  it('accepts "paused" (R-002 drift v2)', () => {
    expect(() => executionRunStatusSchema.parse('paused')).not.toThrow();
    expect(executionRunStatusSchema.parse('paused')).toBe('paused');
  });

  it('still rejects unknown statuses', () => {
    expect(() => executionRunStatusSchema.parse('done')).toThrow();
    expect(() => executionRunStatusSchema.parse('aborted')).toThrow();
    expect(() => executionRunStatusSchema.parse('')).toThrow();
  });

  it('emits superseded and paused as valid enum options', () => {
    expect(executionRunStatusSchema.options).toContain('superseded');
    expect(executionRunStatusSchema.options).toContain('paused');
  });
});

describe('migration SQL — CHECK constraint stays in sync with the zod enum', () => {
  it('20260521000000 introduced superseded', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const sqlPath = path.resolve(
      __dirname,
      '../../prisma/migrations/20260521000000_add_execution_run_superseded/migration.sql',
    );
    const sql = await fs.readFile(sqlPath, 'utf8');
    expect(sql).toMatch(/CHECK/);
    expect(sql).toMatch(/'superseded'/);
    expect(sql).toMatch(/execution_runs_status_check/);
  });

  it('20260521063000 extends the constraint to include paused', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const sqlPath = path.resolve(
      __dirname,
      '../../prisma/migrations/20260521063000_add_execution_run_paused/migration.sql',
    );
    const sql = await fs.readFile(sqlPath, 'utf8');
    expect(sql).toMatch(/DROP CONSTRAINT/);
    expect(sql).toMatch(/'paused'/);
    expect(sql).toMatch(/'superseded'/); // re-issued constraint must keep prior values
    expect(sql).toMatch(/execution_runs_status_check/);
  });
});
