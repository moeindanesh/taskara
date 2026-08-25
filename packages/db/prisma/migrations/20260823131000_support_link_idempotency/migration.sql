ALTER TABLE "SupportCaseTaskLink"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "idempotencyHash" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- Defensive backfill for development databases that created links directly before the API shipped.
UPDATE "SupportCaseTaskLink"
SET "idempotencyKey" = 'legacy:' || "id"::text,
    "idempotencyHash" = encode(sha256(("id"::text)::bytea), 'hex')
WHERE "idempotencyKey" IS NULL;

ALTER TABLE "SupportCaseTaskLink"
  ALTER COLUMN "idempotencyKey" SET NOT NULL,
  ALTER COLUMN "idempotencyHash" SET NOT NULL;

CREATE UNIQUE INDEX "SupportCaseTaskLink_supportWorkspaceId_idempotencyKey_key"
  ON "SupportCaseTaskLink"("supportWorkspaceId", "idempotencyKey");

ALTER TABLE "SupportCaseTaskLink"
  ADD CONSTRAINT "SupportCaseTaskLink_positive_version" CHECK ("version" > 0);
