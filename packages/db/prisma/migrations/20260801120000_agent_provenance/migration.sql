-- CreateEnum
-- One agent User serves all four runtimes (issue #20), so the identity cannot carry the runtime.
-- It rides per-action on the request and is snapshotted onto the row the action produced.
CREATE TYPE "AgentRuntime" AS ENUM ('CLAUDE_CODE', 'CODEX', 'OPENCLAW', 'HERMES');

-- AlterTable
ALTER TABLE "ActivityLog" ADD COLUMN "actorRuntime" "AgentRuntime";

-- AlterTable
-- A notification could not record that an agent caused it: there was no actorId and no actorType,
-- only the actor's name interpolated into free text that nothing parses.
ALTER TABLE "Notification" ADD COLUMN "actorId" UUID;
ALTER TABLE "Notification" ADD COLUMN "actorType" "ActorType" NOT NULL DEFAULT 'SYSTEM';
ALTER TABLE "Notification" ADD COLUMN "actorRuntime" "AgentRuntime";
-- The default exists only to backfill rows written before provenance was recorded, for which
-- "no attributable actor" is the honest answer. It is dropped immediately so that every new
-- notification site has to state provenance and the type checker notices when one does not.
ALTER TABLE "Notification" ALTER COLUMN "actorType" DROP DEFAULT;

-- AddCheckConstraint
-- The runtime qualifies agent authorship and nothing else. A row claiming a runtime while
-- claiming a human author is provenance that contradicts itself, and a human operating a
-- runtime under their own identity is a human authoring work -- that is the whole point of
-- giving agents their own User. A client that declares a runtime while authenticating as a
-- human has that declaration dropped at derivation; this constraint is what holds when a write
-- reaches the database by some other path.
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_runtime_only_for_agents" CHECK (
  "actorRuntime" IS NULL OR "actorType" = 'AGENT'
);
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_runtime_only_for_agents" CHECK (
  "actorRuntime" IS NULL OR "actorType" = 'AGENT'
);

-- CreateIndex
CREATE INDEX "Notification_actorId_idx" ON "Notification"("actorId");

-- AddForeignKey
-- SET NULL, never CASCADE: deleting the actor must not delete the notifications they caused.
-- The actorType snapshot survives the actor and keeps the row readable as agent-caused.
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
