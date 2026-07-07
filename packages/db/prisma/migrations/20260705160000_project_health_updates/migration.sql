-- CreateEnum
CREATE TYPE "ProjectUpdateHealth" AS ENUM ('ON_TRACK', 'AT_RISK', 'OFF_TRACK');

-- CreateTable
CREATE TABLE "ProjectHealthUpdate" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "authorId" UUID,
    "health" "ProjectUpdateHealth" NOT NULL,
    "summary" TEXT NOT NULL,
    "progress" TEXT,
    "risks" TEXT,
    "decisionsNeeded" TEXT,
    "nextUpdateDueAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectHealthUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectHealthUpdate_workspaceId_projectId_createdAt_idx" ON "ProjectHealthUpdate"("workspaceId", "projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ProjectHealthUpdate_workspaceId_health_nextUpdateDueAt_idx" ON "ProjectHealthUpdate"("workspaceId", "health", "nextUpdateDueAt");

-- AddForeignKey
ALTER TABLE "ProjectHealthUpdate" ADD CONSTRAINT "ProjectHealthUpdate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectHealthUpdate" ADD CONSTRAINT "ProjectHealthUpdate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectHealthUpdate" ADD CONSTRAINT "ProjectHealthUpdate_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
