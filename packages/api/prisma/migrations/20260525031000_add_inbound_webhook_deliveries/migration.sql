-- R-new3 / closes #1005 — idempotency record for INBOUND webhook
-- deliveries (e.g. X-GitHub-Delivery). The webhook route inserts a
-- row before fan-out; the @@unique([source, delivery_id]) constraint
-- causes a P2002 on a redelivery so the receiver can short-circuit
-- with 200 instead of writing duplicate outbox rows.
--
-- The 30-day retention column is for a future ops job; not enforced
-- by Postgres so the column can be added without breaking older
-- rows.
CREATE TABLE "inbound_webhook_deliveries" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inbound_webhook_deliveries_source_delivery_id_key"
    ON "inbound_webhook_deliveries"("source", "delivery_id");

-- Operational helper: prune by date range.
CREATE INDEX "inbound_webhook_deliveries_received_at_idx"
    ON "inbound_webhook_deliveries"("received_at");
