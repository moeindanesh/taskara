-- CreateEnum
CREATE TYPE "AttentionItemStatus" AS ENUM ('OPEN', 'SNOOZED', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "AttentionItemSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateTable
CREATE TABLE "AttentionItem" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "assigneeId" UUID,
    "managerId" UUID,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "severity" "AttentionItemSeverity" NOT NULL,
    "status" "AttentionItemStatus" NOT NULL DEFAULT 'OPEN',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snoozedUntil" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "dismissalReason" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttentionItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AttentionItem_workspaceId_entityType_entityId_reason_key" ON "AttentionItem"("workspaceId", "entityType", "entityId", "reason");

-- CreateIndex
CREATE INDEX "AttentionItem_workspaceId_status_severity_lastSeenAt_idx" ON "AttentionItem"("workspaceId", "status", "severity", "lastSeenAt");

-- CreateIndex
CREATE INDEX "AttentionItem_workspaceId_assigneeId_status_idx" ON "AttentionItem"("workspaceId", "assigneeId", "status");

-- CreateIndex
CREATE INDEX "AttentionItem_workspaceId_managerId_status_idx" ON "AttentionItem"("workspaceId", "managerId", "status");

-- AddForeignKey
ALTER TABLE "AttentionItem" ADD CONSTRAINT "AttentionItem_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttentionItem" ADD CONSTRAINT "AttentionItem_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttentionItem" ADD CONSTRAINT "AttentionItem_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
