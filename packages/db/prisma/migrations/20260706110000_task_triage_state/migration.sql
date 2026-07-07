-- CreateEnum
CREATE TYPE "TaskTriageStatus" AS ENUM ('OPEN', 'WAITING_FOR_INFO', 'SNOOZED');

-- CreateTable
CREATE TABLE "TaskTriageState" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "status" "TaskTriageStatus" NOT NULL DEFAULT 'OPEN',
    "requestedInfo" TEXT,
    "snoozedUntil" TIMESTAMP(3),
    "reason" TEXT,
    "decidedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskTriageState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskTriageState_taskId_key" ON "TaskTriageState"("taskId");

-- CreateIndex
CREATE INDEX "TaskTriageState_workspaceId_status_snoozedUntil_idx" ON "TaskTriageState"("workspaceId", "status", "snoozedUntil");

-- CreateIndex
CREATE INDEX "TaskTriageState_workspaceId_decidedById_idx" ON "TaskTriageState"("workspaceId", "decidedById");

-- AddForeignKey
ALTER TABLE "TaskTriageState" ADD CONSTRAINT "TaskTriageState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTriageState" ADD CONSTRAINT "TaskTriageState_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTriageState" ADD CONSTRAINT "TaskTriageState_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
