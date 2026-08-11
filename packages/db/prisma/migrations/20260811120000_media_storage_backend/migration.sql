-- CreateEnum
-- Where an attachment's bytes live. Recorded per row because it genuinely is a property of the
-- row: a key minted by the external CDN exists in no bucket, and a bucket key is not a CDN
-- document id. A deployment-level switch would repoint every historical attachment at a service
-- that has never held its bytes, silently and without a way back.
CREATE TYPE "MediaStorage" AS ENUM ('CDN', 'S3');

-- AlterTable
-- Every row that exists today was minted by the CDN, so the default is not a placeholder standing
-- in for an unknown -- it is the correct answer for all of them, and no backfill is needed.
--
-- The default is deliberately NOT dropped, which is the opposite of the choice
-- `20260801120000_agent_provenance` made for `Notification.actorType`. `migrate deploy` runs from
-- `docker/api-entrypoint.sh` at container start, so between the migration and the new image serving
-- traffic there is a window in which the PREVIOUS image inserts attachment rows without knowing
-- this column exists. With the default dropped those inserts violate NOT NULL and attachment upload
-- 500s for the length of the deploy. Both write sites state `storage` explicitly anyway; the
-- default is what makes the rollout survivable, not what makes the code lazy.
ALTER TABLE "TaskAttachment" ADD COLUMN "storage" "MediaStorage" NOT NULL DEFAULT 'CDN';
ALTER TABLE "KnowledgePageAttachment" ADD COLUMN "storage" "MediaStorage" NOT NULL DEFAULT 'CDN';
