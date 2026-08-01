-- CreateTable
CREATE TABLE "TaskMute" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskMute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskMute_workspaceId_userId_createdAt_idx" ON "TaskMute"("workspaceId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "TaskMute_taskId_idx" ON "TaskMute"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskMute_taskId_userId_key" ON "TaskMute"("taskId", "userId");

-- AddForeignKey
ALTER TABLE "TaskMute" ADD CONSTRAINT "TaskMute_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskMute" ADD CONSTRAINT "TaskMute_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskMute" ADD CONSTRAINT "TaskMute_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
