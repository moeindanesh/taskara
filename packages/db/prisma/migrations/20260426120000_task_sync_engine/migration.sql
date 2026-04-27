CREATE TABLE "WorkspaceSyncState" (
    "workspaceId" UUID NOT NULL,
    "nextSeq" BIGINT NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceSyncState_pkey" PRIMARY KEY ("workspaceId")
);

CREATE TABLE "SyncEvent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "workspaceSeq" BIGINT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "entityVersion" INTEGER,
    "actorId" UUID,
    "clientId" TEXT,
    "mutationId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClientMutation" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "mutationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "resultWorkspaceSeq" BIGINT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientMutation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SyncEvent_workspaceId_workspaceSeq_key" ON "SyncEvent"("workspaceId", "workspaceSeq");
CREATE INDEX "SyncEvent_workspaceId_entityType_entityId_idx" ON "SyncEvent"("workspaceId", "entityType", "entityId");
CREATE INDEX "SyncEvent_workspaceId_clientId_mutationId_idx" ON "SyncEvent"("workspaceId", "clientId", "mutationId");

CREATE UNIQUE INDEX "ClientMutation_workspaceId_clientId_mutationId_key" ON "ClientMutation"("workspaceId", "clientId", "mutationId");
CREATE INDEX "ClientMutation_workspaceId_userId_createdAt_idx" ON "ClientMutation"("workspaceId", "userId", "createdAt");
