-- CreateEnum
CREATE TYPE "MilestoneKind" AS ENUM ('FEATURE', 'PHASE', 'OTHER');

-- CreateEnum
CREATE TYPE "MilestoneStatus" AS ENUM ('PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELED');

-- CreateEnum
CREATE TYPE "MilestoneHealth" AS ENUM ('ON_TRACK', 'AT_RISK', 'OFF_TRACK');

-- CreateTable
CREATE TABLE "Milestone" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "ownerId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "MilestoneKind" NOT NULL,
    "status" "MilestoneStatus" NOT NULL DEFAULT 'PLANNED',
    "health" "MilestoneHealth",
    "startsOn" DATE,
    "targetOn" DATE,
    "position" INTEGER NOT NULL DEFAULT 1024,
    "version" INTEGER NOT NULL DEFAULT 1,
    "completedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Milestone_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "milestoneId" UUID;

-- CreateIndex
CREATE INDEX "Milestone_projectId_position_idx" ON "Milestone"("projectId", "position");

-- CreateIndex
CREATE INDEX "Milestone_workspaceId_archivedAt_status_targetOn_idx" ON "Milestone"("workspaceId", "archivedAt", "status", "targetOn");

-- CreateIndex
CREATE INDEX "Milestone_ownerId_status_idx" ON "Milestone"("ownerId", "status");

-- CreateIndex
CREATE INDEX "Task_milestoneId_status_idx" ON "Task"("milestoneId", "status");

-- AddForeignKey
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "Milestone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
