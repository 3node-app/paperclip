-- Enforce one managed Kubernetes sandbox environment per company.
--
-- Background: there was no DB constraint preventing two concurrent callers
-- (e.g. concurrent heartbeats lazily provisioning a new company) from both
-- inserting a managed k8s sandbox row. The application tried to converge
-- post-insert, but that re-read-and-delete-own-row strategy has a real race
-- (a caller that re-reads before a competing row is inserted keeps its own row,
-- and the competitor also keeps itself), so duplicates could persist. This adds
-- the proper DB-level invariant, mirroring the existing partial unique index for
-- the default `local` environment.

-- 1. Collapse any pre-existing duplicates: keep the oldest (created_at, id) row
--    per company and re-point its leases to the survivor before deleting losers.
WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY company_id ORDER BY created_at ASC, id ASC
    ) AS winner_id,
    row_number() OVER (
      PARTITION BY company_id ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM environments
  WHERE driver = 'sandbox'
    AND metadata ->> 'managedKubernetesSandbox' = 'true'
)
UPDATE environment_leases AS l
SET environment_id = r.winner_id
FROM ranked AS r
WHERE l.environment_id = r.id
  AND r.rn > 1;--> statement-breakpoint

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY company_id ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM environments
  WHERE driver = 'sandbox'
    AND metadata ->> 'managedKubernetesSandbox' = 'true'
)
DELETE FROM environments
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);--> statement-breakpoint

-- 2. Enforce the invariant going forward.
CREATE UNIQUE INDEX IF NOT EXISTS "environments_company_managed_k8s_idx"
  ON "environments" USING btree ("company_id")
  WHERE "driver" = 'sandbox' AND "metadata" ->> 'managedKubernetesSandbox' = 'true';
