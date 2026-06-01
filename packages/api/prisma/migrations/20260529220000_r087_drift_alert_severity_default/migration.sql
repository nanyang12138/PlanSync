-- R-087: backfill default for drift_alerts.severity so future inserts that
-- forget to set it land as 'medium' rather than failing the NOT NULL check.
-- The column is already NOT NULL; this only attaches the DEFAULT clause.
ALTER TABLE "drift_alerts" ALTER COLUMN "severity" SET DEFAULT 'medium';
