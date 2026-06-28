-- Per-tenant brand accent. Nullable: existing tenants fall back to the default brand.
-- The table is not under RLS; the existing `GRANT SELECT ON "tenants" TO flashbite_app`
-- is table-level and already covers this new column (no new grant needed).
ALTER TABLE "tenants" ADD COLUMN "brand_color" TEXT;
