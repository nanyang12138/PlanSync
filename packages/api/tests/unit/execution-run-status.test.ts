import { describe, it, expect } from 'vitest';
import { executionRunStatusSchema } from '@plansync/shared';

describe('R-008: executionRunStatusSchema accepts superseded', () => {
  it('accepts the legacy set of statuses', () => {
    for (const status of ['running', 'completed', 'failed', 'cancelled', 'stale']) {
      expect(() => executionRunStatusSchema.parse(status)).not.toThrow();
    }
  });

  it('accepts the new "superseded" status', () => {
    expect(() => executionRunStatusSchema.parse('superseded')).not.toThrow();
    expect(executionRunStatusSchema.parse('superseded')).toBe('superseded');
  });

  it('still rejects unknown statuses', () => {
    expect(() => executionRunStatusSchema.parse('done')).toThrow();
    expect(() => executionRunStatusSchema.parse('paused')).toThrow();
    expect(() => executionRunStatusSchema.parse('')).toThrow();
  });

  it('emits superseded as a valid enum option', () => {
    expect(executionRunStatusSchema.options).toContain('superseded');
  });
});

describe('R-008: migration SQL contains the new status', () => {
  it('CHECK constraint accepts superseded', async () => {
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
});
