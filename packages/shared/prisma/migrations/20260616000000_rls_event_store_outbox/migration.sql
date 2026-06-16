-- Restricted application role for RLS-enforced tenant isolation on the write plane.
-- The existing `flashbite` role is a SUPERUSER and bypasses RLS; write-api + saga-worker
-- connect as `flashbite_app` (non-superuser) so the policies below actually bind.
-- Password is local-dev-only, mirroring infra/docker-compose.yml; never a real secret.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flashbite_app') THEN
    CREATE ROLE flashbite_app LOGIN PASSWORD 'flashbite_app_local_dev' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO flashbite_app;
GRANT SELECT, INSERT, UPDATE ON event_store TO flashbite_app;
GRANT SELECT, INSERT, UPDATE ON outbox TO flashbite_app;

-- Enable + force RLS. FORCE also binds the table owner (harmless here since the owner
-- is the superuser `flashbite`, which bypasses RLS regardless; kept for defense-in-depth
-- if ownership ever changes to a non-superuser).
ALTER TABLE event_store ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_store FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;

-- Tenant-scoped policy: a row is visible/writable only when its tenant_id matches the
-- per-transaction GUC app.tenant_id. Unset GUC -> current_setting(...,true) = NULL ->
-- comparison is NULL -> fail-closed (no rows, blocked insert).
CREATE POLICY tenant_isolation ON event_store
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation ON outbox
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
