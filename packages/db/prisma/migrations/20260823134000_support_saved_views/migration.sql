CREATE TYPE "SupportSavedViewVisibility" AS ENUM ('PRIVATE', 'DEPARTMENT', 'WORKSPACE');

CREATE TABLE "SupportSavedView" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "ownerId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "visibility" "SupportSavedViewVisibility" NOT NULL DEFAULT 'PRIVATE',
  "departmentId" UUID,
  "filters" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SupportSavedView_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportSavedView_version_check" CHECK ("version" > 0),
  CONSTRAINT "SupportSavedView_visibility_department_check" CHECK (
    ("visibility" = 'DEPARTMENT' AND "departmentId" IS NOT NULL)
    OR ("visibility" IN ('PRIVATE', 'WORKSPACE') AND "departmentId" IS NULL)
  )
);

CREATE UNIQUE INDEX "SupportSavedView_workspaceId_id_key"
  ON "SupportSavedView"("workspaceId", "id");
CREATE INDEX "SupportSavedView_workspaceId_ownerId_updatedAt_idx"
  ON "SupportSavedView"("workspaceId", "ownerId", "updatedAt");
CREATE INDEX "SupportSavedView_workspaceId_visibility_departmentId_updatedAt_idx"
  ON "SupportSavedView"("workspaceId", "visibility", "departmentId", "updatedAt");

ALTER TABLE "SupportSavedView"
  ADD CONSTRAINT "SupportSavedView_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportSavedView"
  ADD CONSTRAINT "SupportSavedView_workspaceId_ownerId_fkey"
  FOREIGN KEY ("workspaceId", "ownerId")
  REFERENCES "WorkspaceMember"("workspaceId", "userId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportSavedView"
  ADD CONSTRAINT "SupportSavedView_workspaceId_departmentId_fkey"
  FOREIGN KEY ("workspaceId", "departmentId")
  REFERENCES "Department"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
