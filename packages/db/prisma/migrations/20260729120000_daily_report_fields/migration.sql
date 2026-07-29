-- Daily report: unexpected-work section + canonical Tehran calendar day per report.

-- AlterTable
ALTER TABLE "CheckInResponse" ADD COLUMN     "unplannedText" TEXT,
ADD COLUMN     "dateKey" TEXT;

-- Backfill dateKey from submittedFor using the workspace clock (Asia/Tehran).
UPDATE "CheckInResponse"
SET "dateKey" = to_char("submittedFor" AT TIME ZONE 'Asia/Tehran', 'YYYY-MM-DD')
WHERE "dateKey" IS NULL;

-- Collapse pre-existing duplicates so the unique index can be created:
-- keep the most recently submitted row per (workspace, user, day).
DELETE FROM "CheckInResponse" a
USING "CheckInResponse" b
WHERE a."workspaceId" = b."workspaceId"
  AND a."userId" = b."userId"
  AND a."dateKey" = b."dateKey"
  AND (a."submittedFor", a."createdAt", a."id") < (b."submittedFor", b."createdAt", b."id");

-- CreateIndex
CREATE UNIQUE INDEX "CheckInResponse_workspaceId_userId_dateKey_key" ON "CheckInResponse"("workspaceId", "userId", "dateKey");

-- CreateIndex
CREATE INDEX "CheckInResponse_workspaceId_dateKey_idx" ON "CheckInResponse"("workspaceId", "dateKey");
