-- CreateTable
CREATE TABLE "event_store" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "partition_key" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "tenant_id" TEXT NOT NULL,
    "consumer" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("tenant_id","consumer","event_id")
);

-- CreateIndex
CREATE INDEX "event_store_tenant_id_aggregate_id_idx" ON "event_store"("tenant_id", "aggregate_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_store_tenant_id_aggregate_id_version_key" ON "event_store"("tenant_id", "aggregate_id", "version");

-- CreateIndex
CREATE INDEX "outbox_status_created_at_idx" ON "outbox"("status", "created_at");
