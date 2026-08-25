-- HMAC sources need their high-entropy signing key at verification time. Keep it encrypted with
-- the deployment's Support data key; the plaintext is returned only once when the connector is
-- created or rotated.
ALTER TABLE "SupportIntakeConnector"
  ADD COLUMN "secretCiphertext" TEXT,
  ADD COLUMN "secretEncryptionKeyId" TEXT;

-- Existing development rows (if any) cannot be authenticated safely because earlier code never
-- stored a recoverable signing key. Revoke them before making the encrypted key mandatory.
UPDATE "SupportIntakeConnector"
SET "status" = 'REVOKED', "revokedAt" = COALESCE("revokedAt", CURRENT_TIMESTAMP)
WHERE "secretCiphertext" IS NULL;

ALTER TABLE "SupportIntakeConnector"
  ALTER COLUMN "secretCiphertext" SET NOT NULL;

-- Exact webhook bytes must survive the quick 202 response so a leased worker can process them.
-- The bytes are ciphertext, never a parsed or plaintext JSON blob.
ALTER TABLE "SupportIntakeReceipt"
  ADD COLUMN "payloadCiphertext" BYTEA,
  ADD COLUMN "payloadEncryptionKeyId" TEXT,
  ADD COLUMN "payloadRetentionUntil" TIMESTAMP(3);

CREATE INDEX "SupportIntakeReceipt_payloadRetentionUntil_idx"
  ON "SupportIntakeReceipt"("payloadRetentionUntil");
