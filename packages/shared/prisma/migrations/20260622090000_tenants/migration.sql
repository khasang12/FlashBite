CREATE TABLE "tenants" (
    "slug" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tenants_pkey" PRIMARY KEY ("slug")
);

-- The restricted app role (read-api/write-api/saga-worker) must read the catalog.
-- Not under RLS: this is the global cross-tenant catalog.
GRANT SELECT ON "tenants" TO flashbite_app;
