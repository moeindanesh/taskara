-- Prisma's historical OneOnOneSeries migration used an identifier PostgreSQL silently truncated.
-- Give it Prisma's current deterministic short name so `migrate dev` sees no phantom rename.
ALTER INDEX "OneOnOneSeries_workspaceId_participantId_active_nextScheduledAt_idx"
  RENAME TO "OneOnOneSeries_workspaceId_participantId_active_nextSchedul_idx";

-- A notification keeps its Support entity identity so reads can re-run assignment-scoped access
-- after a transfer. RESTRICT makes Case retention explicit rather than silently orphaning privacy
-- metadata; a deletion workflow must first tombstone or remove its notification projections.
ALTER TABLE "Notification" ADD COLUMN "supportCaseId" UUID;

CREATE INDEX "Notification_supportCaseId_idx" ON "Notification"("supportCaseId");

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_workspaceId_supportCaseId_fkey"
  FOREIGN KEY ("workspaceId", "supportCaseId")
  REFERENCES "SupportCase"("workspaceId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
