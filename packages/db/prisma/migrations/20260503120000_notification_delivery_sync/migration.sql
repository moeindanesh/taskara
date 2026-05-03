-- Track notification delivery and speed up incremental notification sync.
ALTER TABLE "Notification" ADD COLUMN "deliveredAt" TIMESTAMP(3);

CREATE INDEX "Notification_userId_deliveredAt_idx" ON "Notification"("userId", "deliveredAt");
CREATE INDEX "Notification_userId_createdAt_id_idx" ON "Notification"("userId", "createdAt", "id");
