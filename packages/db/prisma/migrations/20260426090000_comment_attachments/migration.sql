-- Allow task attachments to be associated with a specific comment while
-- preserving existing task-level attachments for descriptions and issue files.
ALTER TABLE "TaskAttachment" ADD COLUMN "commentId" UUID;

CREATE INDEX "TaskAttachment_commentId_createdAt_idx" ON "TaskAttachment"("commentId", "createdAt");

ALTER TABLE "TaskAttachment"
ADD CONSTRAINT "TaskAttachment_commentId_fkey"
FOREIGN KEY ("commentId") REFERENCES "TaskComment"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
