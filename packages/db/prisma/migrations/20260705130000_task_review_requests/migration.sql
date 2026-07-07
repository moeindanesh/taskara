-- CreateEnum
CREATE TYPE "TaskReviewStatus" AS ENUM ('REQUESTED', 'CHANGES_REQUESTED', 'APPROVED', 'CANCELED');

-- CreateTable
CREATE TABLE "TaskReviewRequest" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "requesterId" UUID,
    "reviewerId" UUID NOT NULL,
    "status" "TaskReviewStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskReviewRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskReviewRequest_workspaceId_reviewerId_status_dueAt_idx" ON "TaskReviewRequest"("workspaceId", "reviewerId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "TaskReviewRequest_workspaceId_taskId_status_idx" ON "TaskReviewRequest"("workspaceId", "taskId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TaskReviewRequest_one_requested_per_task_idx" ON "TaskReviewRequest"("workspaceId", "taskId") WHERE "status" = 'REQUESTED';

-- AddForeignKey
ALTER TABLE "TaskReviewRequest" ADD CONSTRAINT "TaskReviewRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskReviewRequest" ADD CONSTRAINT "TaskReviewRequest_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskReviewRequest" ADD CONSTRAINT "TaskReviewRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskReviewRequest" ADD CONSTRAINT "TaskReviewRequest_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
