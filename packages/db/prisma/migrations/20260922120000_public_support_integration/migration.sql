ALTER TABLE "SupportCase"
  ADD COLUMN "metadata" JSONB,
  ADD COLUMN "publicClientRequestId" TEXT;

CREATE UNIQUE INDEX "SupportCase_workspaceId_publicClientRequestId_key"
  ON "SupportCase"("workspaceId", "publicClientRequestId");

ALTER TABLE "SupportInteraction"
  ADD COLUMN "metadata" JSONB,
  ADD COLUMN "publicClientRequestId" TEXT;

CREATE UNIQUE INDEX "SupportInteraction_workspaceId_publicClientRequestId_key"
  ON "SupportInteraction"("workspaceId", "publicClientRequestId");
