-- CreateTable
CREATE TABLE "UserCapacity" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "dailyWeightLimit" DOUBLE PRECISION NOT NULL DEFAULT 8,
    "weeklyWeightLimit" DOUBLE PRECISION,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserCapacity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamWorkingAgreement" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "teamId" UUID,
    "scopeKey" TEXT NOT NULL,
    "activeWipLimit" INTEGER,
    "reviewWipLimit" INTEGER,
    "reviewSlaHours" INTEGER NOT NULL DEFAULT 24,
    "blockedSlaHours" INTEGER NOT NULL DEFAULT 24,
    "staleAfterHours" INTEGER NOT NULL DEFAULT 72,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamWorkingAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserCapacity_workspaceId_userId_key" ON "UserCapacity"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "UserCapacity_workspaceId_active_idx" ON "UserCapacity"("workspaceId", "active");

-- CreateIndex
CREATE INDEX "UserCapacity_userId_idx" ON "UserCapacity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamWorkingAgreement_workspaceId_scopeKey_key" ON "TeamWorkingAgreement"("workspaceId", "scopeKey");

-- CreateIndex
CREATE INDEX "TeamWorkingAgreement_workspaceId_teamId_idx" ON "TeamWorkingAgreement"("workspaceId", "teamId");

-- AddForeignKey
ALTER TABLE "UserCapacity" ADD CONSTRAINT "UserCapacity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCapacity" ADD CONSTRAINT "UserCapacity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamWorkingAgreement" ADD CONSTRAINT "TeamWorkingAgreement_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamWorkingAgreement" ADD CONSTRAINT "TeamWorkingAgreement_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
