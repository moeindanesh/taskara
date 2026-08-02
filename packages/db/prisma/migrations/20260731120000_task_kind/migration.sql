-- CreateEnum
CREATE TYPE "TaskKind" AS ENUM ('WORK', 'EFFORT');

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "kind" "TaskKind" NOT NULL DEFAULT 'WORK';

-- AddCheckConstraint
ALTER TABLE "Task" ADD CONSTRAINT "Task_effort_has_no_work_fields" CHECK (
  "kind" = 'WORK' OR (
    "assigneeId" IS NULL AND "dueAt" IS NULL AND "weight" IS NULL
    AND "milestoneId" IS NULL AND "cycleId" IS NULL AND "parentId" IS NULL
  )
);

-- AddCheckConstraint
ALTER TABLE "Task" ADD CONSTRAINT "Task_effort_status" CHECK (
  "kind" = 'WORK' OR "status" IN ('IN_PROGRESS', 'DONE', 'CANCELED')
);

-- CreateIndex
CREATE INDEX "Task_workspaceId_kind_status_idx" ON "Task"("workspaceId", "kind", "status");
